// ================================================================
// CodePocket — DynamoDB Table Setup Script
// Run once to create all tables in AWS
//
// Usage: node database/setup.js
// Requires: AWS credentials configured (aws configure)
// ================================================================

const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
} = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

// ─────────────────────────────────────────
// TABLE DEFINITIONS
// ─────────────────────────────────────────

const TABLE_SCHEMAS = [

  // ── 1. Templates Table ──────────────────
  // Partition key: templateId (UUID)
  // GSI 1: lang-index     → query by language
  // GSI 2: author-index   → query by author
  {
    TableName:             'codepocket-templates',
    BillingMode:           'PAY_PER_REQUEST',  // No capacity planning needed
    KeySchema: [
      { AttributeName: 'templateId', KeyType: 'HASH' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'templateId', AttributeType: 'S' },
      { AttributeName: 'lang',       AttributeType: 'S' },
      { AttributeName: 'author',     AttributeType: 'S' },
      { AttributeName: 'createdAt',  AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'lang-createdAt-index',
        KeySchema: [
          { AttributeName: 'lang',      KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
      {
        IndexName: 'author-createdAt-index',
        KeySchema: [
          { AttributeName: 'author',    KeyType: 'HASH' },
          { AttributeName: 'createdAt', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    Tags: [
      { Key: 'Project', Value: 'CodePocket' },
      { Key: 'Env',     Value: 'production' },
    ],
  },

  // ── 2. Users Table ─────────────────────
  // Partition key: userId (UUID)
  // GSI: username-index → lookup by username
  {
    TableName:   'codepocket-users',
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'userId',   AttributeType: 'S' },
      { AttributeName: 'username', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'username-index',
        KeySchema: [
          { AttributeName: 'username', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    Tags: [
      { Key: 'Project', Value: 'CodePocket' },
    ],
  },

  // ── 3. Saves Table ─────────────────────
  // Partition key: saveId (userId#templateId composite)
  // GSI: userId-index → get all saves by a user
  {
    TableName:   'codepocket-saves',
    BillingMode: 'PAY_PER_REQUEST',
    KeySchema: [
      { AttributeName: 'saveId', KeyType: 'HASH' },
    ],
    AttributeDefinitions: [
      { AttributeName: 'saveId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: 'userId-index',
        KeySchema: [
          { AttributeName: 'userId', KeyType: 'HASH' },
        ],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
    Tags: [
      { Key: 'Project', Value: 'CodePocket' },
    ],
  },
];

// ─────────────────────────────────────────
// SEED DATA (optional starter templates)
// ─────────────────────────────────────────
const SEED_TEMPLATES = [
  {
    templateId: 'seed-001',
    name: 'Async Fetch Wrapper',
    lang: 'JavaScript',
    desc: 'Reusable async/await fetch wrapper with error handling.',
    code: `async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) throw new Error(\`HTTP \${res.status}: \${res.statusText}\`);
  return res.json();
}`,
    author:    'codepocket',
    tags:      ['async', 'fetch', 'api'],
    stars:     42,
    uses:      218,
    status:    'published',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  },
  {
    templateId: 'seed-002',
    name: 'Python Dataclass',
    lang: 'Python',
    desc: 'Clean Python dataclass with type hints and validation.',
    code: `from dataclasses import dataclass, field
from typing import List

@dataclass
class User:
    name:  str
    email: str
    tags:  List[str] = field(default_factory=list)
    
    def __post_init__(self):
        self.email = self.email.lower()`,
    author:    'codepocket',
    tags:      ['python', 'dataclass', 'oop'],
    stars:     31,
    uses:      145,
    status:    'published',
    createdAt: '2025-01-02T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
  },
];

// ─────────────────────────────────────────
// CREATE TABLES
// ─────────────────────────────────────────
async function tableExists(name) {
  try {
    const tables = await client.send(new ListTablesCommand({}));
    return tables.TableNames.includes(name);
  } catch {
    return false;
  }
}

async function waitForActive(name) {
  process.stdout.write(`   Waiting for ${name} to become ACTIVE`);
  while (true) {
    const desc = await client.send(new DescribeTableCommand({ TableName: name }));
    if (desc.Table.TableStatus === 'ACTIVE') { console.log(' ✓'); break; }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function createTables() {
  console.log('\n🗄️  CodePocket — DynamoDB Setup\n');

  for (const schema of TABLE_SCHEMAS) {
    const exists = await tableExists(schema.TableName);
    if (exists) {
      console.log(`⏭  ${schema.TableName} already exists, skipping.`);
      continue;
    }
    console.log(`🔨 Creating table: ${schema.TableName}`);
    try {
      await client.send(new CreateTableCommand(schema));
      await waitForActive(schema.TableName);
    } catch (err) {
      console.error(`❌ Failed to create ${schema.TableName}:`, err.message);
      process.exit(1);
    }
  }

  console.log('\n✅ All tables ready!\n');
}

createTables().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});


// ─────────────────────────────────────────
// SCHEMA REFERENCE (for docs / visualization)
// ─────────────────────────────────────────
/*
╔══════════════════════════════════════════════════════════╗
║          codepocket-templates                            ║
╠════════════════════╦═════════════════════════════════════╣
║ templateId (PK)    ║ String — UUID                       ║
║ name               ║ String — Template name              ║
║ lang               ║ String — JavaScript/Python/etc      ║
║ desc               ║ String — Short description          ║
║ code               ║ String — Full code content          ║
║ author             ║ String — Username of creator        ║
║ tags               ║ List<String> — Search tags          ║
║ stars              ║ Number — Star count                 ║
║ uses               ║ Number — Times loaded in editor     ║
║ status             ║ String — published | draft          ║
║ createdAt          ║ String — ISO 8601 timestamp         ║
║ updatedAt          ║ String — ISO 8601 timestamp         ║
╚════════════════════╩═════════════════════════════════════╝
GSI 1: lang-createdAt-index      (query templates by language)
GSI 2: author-createdAt-index    (query templates by author)

╔══════════════════════════════════════════════════════════╗
║          codepocket-users                                ║
╠════════════════════╦═════════════════════════════════════╣
║ userId (PK)        ║ String — UUID                       ║
║ username           ║ String — Unique handle              ║
║ email              ║ String — Lowercase email            ║
║ displayName        ║ String — Display name               ║
║ templates          ║ Number — Template count (cached)    ║
║ createdAt          ║ String — ISO 8601 timestamp         ║
╚════════════════════╩═════════════════════════════════════╝
GSI: username-index    (lookup user by username)

╔══════════════════════════════════════════════════════════╗
║          codepocket-saves                                ║
╠════════════════════╦═════════════════════════════════════╣
║ saveId (PK)        ║ String — "{userId}#{templateId}"    ║
║ userId             ║ String — Foreign key to users       ║
║ templateId         ║ String — Foreign key to templates   ║
║ savedAt            ║ String — ISO 8601 timestamp         ║
╚════════════════════╩═════════════════════════════════════╝
GSI: userId-index      (get all saves for a user)
*/
