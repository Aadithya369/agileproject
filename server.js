// ================================================================
// CodePocket Backend — server.js
// Node.js + Express + AWS DynamoDB
// ================================================================

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const app = express();
const PORT = process.env.PORT || 3000;

// ── AWS DynamoDB Client ──
const dynamoDB = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  // Credentials auto-loaded from IAM role when deployed on EC2/Lambda
  // For local dev, set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env
});

// ── Middleware ──
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('../frontend'));  // Serve frontend

// ── Request logger ──
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ── Table names ──
const TABLES = {
  TEMPLATES: 'codepocket-templates',
  USERS:     'codepocket-users',
  SAVES:     'codepocket-saves',
};

// ================================================================
// TEMPLATES ENDPOINTS
// ================================================================

/**
 * GET /api/templates
 * Returns all community templates, optionally filtered by language
 * Query: ?lang=JavaScript&limit=20&lastKey=xxx
 */
app.get('/api/templates', async (req, res) => {
  try {
    const { lang, limit = 20, lastKey } = req.query;

    const params = {
      TableName: TABLES.TEMPLATES,
      Limit: parseInt(limit),
      FilterExpression: '#status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({ ':status': 'published' }),
    };

    // Add language filter if provided
    if (lang) {
      params.FilterExpression += ' AND #lang = :lang';
      params.ExpressionAttributeNames['#lang'] = 'lang';
      params.ExpressionAttributeValues[':lang'] = { S: lang };
    }

    // Pagination
    if (lastKey) {
      params.ExclusiveStartKey = JSON.parse(Buffer.from(lastKey, 'base64').toString());
    }

    const result = await dynamoDB.send(new ScanCommand(params));
    const templates = result.Items.map(item => unmarshall(item));

    // Sort by stars descending
    templates.sort((a, b) => (b.stars || 0) - (a.stars || 0));

    res.json({
      templates,
      nextKey: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
        : null,
    });
  } catch (err) {
    console.error('GET /api/templates error:', err);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

/**
 * GET /api/templates/:id
 * Returns a single template by ID
 */
app.get('/api/templates/:id', async (req, res) => {
  try {
    const result = await dynamoDB.send(new GetItemCommand({
      TableName: TABLES.TEMPLATES,
      Key: marshall({ templateId: req.params.id }),
    }));

    if (!result.Item) {
      return res.status(404).json({ error: 'Template not found' });
    }

    res.json(unmarshall(result.Item));
  } catch (err) {
    console.error('GET /api/templates/:id error:', err);
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

/**
 * POST /api/templates
 * Creates a new community template
 * Body: { name, lang, desc, code, author, tags[] }
 */
app.post('/api/templates', async (req, res) => {
  try {
    const { name, lang, desc, code, author, tags = [] } = req.body;

    // Validation
    if (!name || !lang || !code || !author) {
      return res.status(400).json({ error: 'Missing required fields: name, lang, code, author' });
    }

    const template = {
      templateId:  uuidv4(),
      name:        name.trim(),
      lang,
      desc:        desc?.trim() || '',
      code,
      author,
      tags,
      stars:       0,
      uses:        0,
      status:      'published',
      createdAt:   new Date().toISOString(),
      updatedAt:   new Date().toISOString(),
    };

    await dynamoDB.send(new PutItemCommand({
      TableName: TABLES.TEMPLATES,
      Item: marshall(template),
    }));

    res.status(201).json(template);
  } catch (err) {
    console.error('POST /api/templates error:', err);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

/**
 * PUT /api/templates/:id/star
 * Increment star count on a template
 */
app.put('/api/templates/:id/star', async (req, res) => {
  try {
    const result = await dynamoDB.send(new UpdateItemCommand({
      TableName:        TABLES.TEMPLATES,
      Key:              marshall({ templateId: req.params.id }),
      UpdateExpression: 'SET stars = if_not_exists(stars, :zero) + :inc',
      ExpressionAttributeValues: marshall({ ':inc': 1, ':zero': 0 }),
      ReturnValues:     'ALL_NEW',
    }));

    res.json(unmarshall(result.Attributes));
  } catch (err) {
    console.error('PUT /api/templates/:id/star error:', err);
    res.status(500).json({ error: 'Failed to star template' });
  }
});

/**
 * PUT /api/templates/:id/use
 * Increment use count when a user loads the template into editor
 */
app.put('/api/templates/:id/use', async (req, res) => {
  try {
    await dynamoDB.send(new UpdateItemCommand({
      TableName:        TABLES.TEMPLATES,
      Key:              marshall({ templateId: req.params.id }),
      UpdateExpression: 'SET #uses = if_not_exists(#uses, :zero) + :inc',
      ExpressionAttributeNames:  { '#uses': 'uses' },
      ExpressionAttributeValues: marshall({ ':inc': 1, ':zero': 0 }),
    }));

    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/templates/:id/use error:', err);
    res.status(500).json({ error: 'Failed to update use count' });
  }
});

/**
 * DELETE /api/templates/:id
 * Delete a template (only by owner)
 */
app.delete('/api/templates/:id', async (req, res) => {
  try {
    const { author } = req.body;

    // Verify ownership
    const existing = await dynamoDB.send(new GetItemCommand({
      TableName: TABLES.TEMPLATES,
      Key: marshall({ templateId: req.params.id }),
    }));

    if (!existing.Item) return res.status(404).json({ error: 'Not found' });
    const item = unmarshall(existing.Item);
    if (item.author !== author) return res.status(403).json({ error: 'Not authorized' });

    await dynamoDB.send(new DeleteItemCommand({
      TableName: TABLES.TEMPLATES,
      Key: marshall({ templateId: req.params.id }),
    }));

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/templates/:id error:', err);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// ================================================================
// USERS ENDPOINTS
// ================================================================

/**
 * POST /api/users
 * Register or update a user profile
 */
app.post('/api/users', async (req, res) => {
  try {
    const { username, email, displayName } = req.body;
    if (!username || !email) {
      return res.status(400).json({ error: 'Missing username or email' });
    }

    const user = {
      userId:      uuidv4(),
      username:    username.trim().toLowerCase(),
      email:       email.trim().toLowerCase(),
      displayName: displayName || username,
      templates:   0,
      createdAt:   new Date().toISOString(),
    };

    await dynamoDB.send(new PutItemCommand({
      TableName:           TABLES.USERS,
      Item:                marshall(user),
      ConditionExpression: 'attribute_not_exists(username)',
    }));

    res.status(201).json(user);
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    console.error('POST /api/users error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * GET /api/users/:username
 * Get user profile + their templates
 */
app.get('/api/users/:username', async (req, res) => {
  try {
    const usernameParam = req.params.username.toLowerCase();

    // Scan for user by username
    const userResult = await dynamoDB.send(new ScanCommand({
      TableName:                 TABLES.USERS,
      FilterExpression:          'username = :username',
      ExpressionAttributeValues: marshall({ ':username': usernameParam }),
      Limit:                     1,
    }));

    if (!userResult.Items.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = unmarshall(userResult.Items[0]);

    // Fetch their templates
    const templatesResult = await dynamoDB.send(new ScanCommand({
      TableName:                 TABLES.TEMPLATES,
      FilterExpression:          'author = :author AND #status = :status',
      ExpressionAttributeNames:  { '#status': 'status' },
      ExpressionAttributeValues: marshall({ ':author': usernameParam, ':status': 'published' }),
    }));

    user.templateList = templatesResult.Items.map(i => unmarshall(i));
    user.templates    = user.templateList.length;

    res.json(user);
  } catch (err) {
    console.error('GET /api/users/:username error:', err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ================================================================
// SAVES ENDPOINTS  (User's personal saved templates)
// ================================================================

/**
 * POST /api/saves
 * Save a template to user's personal collection
 */
app.post('/api/saves', async (req, res) => {
  try {
    const { userId, templateId } = req.body;
    if (!userId || !templateId) {
      return res.status(400).json({ error: 'Missing userId or templateId' });
    }

    const save = {
      saveId:     `${userId}#${templateId}`,
      userId,
      templateId,
      savedAt:    new Date().toISOString(),
    };

    await dynamoDB.send(new PutItemCommand({
      TableName: TABLES.SAVES,
      Item:      marshall(save),
    }));

    res.status(201).json(save);
  } catch (err) {
    console.error('POST /api/saves error:', err);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

/**
 * GET /api/saves/:userId
 * Get all templates saved by a user
 */
app.get('/api/saves/:userId', async (req, res) => {
  try {
    const savesResult = await dynamoDB.send(new ScanCommand({
      TableName:                 TABLES.SAVES,
      FilterExpression:          'userId = :userId',
      ExpressionAttributeValues: marshall({ ':userId': req.params.userId }),
    }));

    const saves = savesResult.Items.map(i => unmarshall(i));
    res.json(saves);
  } catch (err) {
    console.error('GET /api/saves/:userId error:', err);
    res.status(500).json({ error: 'Failed to fetch saves' });
  }
});

// ================================================================
// HEALTH CHECK
// ================================================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// ── Start server ──
app.listen(PORT, () => {
  console.log(`\n🚀 CodePocket API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Templates: http://localhost:${PORT}/api/templates\n`);
});

module.exports = app;
