# CodePocket — AWS Deployment Guide

## Architecture Overview

```
Browser (Mobile UI)
       │
       ▼
  CloudFront CDN  ──▶  S3 Bucket (frontend/index.html)
       │
       ▼
  API Gateway  ──▶  EC2 (Node.js server.js)  ──▶  DynamoDB (3 tables)
                         │
                    IAM Role (DynamoDB access)
```

---

## Prerequisites

- AWS account with admin access
- AWS CLI installed: `brew install awscli` or from https://aws.amazon.com/cli/
- Node.js 18+ installed locally
- Git installed

---

## Step 1 — Configure AWS CLI

```bash
aws configure
# Enter when prompted:
# AWS Access Key ID:     <your key>
# AWS Secret Access Key: <your secret>
# Default region name:   us-east-1
# Default output format: json
```

---

## Step 2 — Create DynamoDB Tables

```bash
# From the project root
cd database
npm install
node setup.js
# This creates: codepocket-templates, codepocket-users, codepocket-saves
```

Verify in the AWS Console:  
`AWS Console → DynamoDB → Tables` — you should see all 3 tables with status ACTIVE.

---

## Step 3 — Deploy Frontend to S3 + CloudFront

### 3a. Create an S3 Bucket

```bash
aws s3 mb s3://codepocket-frontend-YOUR_UNIQUE_SUFFIX --region us-east-1

# Enable static website hosting
aws s3 website s3://codepocket-frontend-YOUR_UNIQUE_SUFFIX \
  --index-document index.html \
  --error-document index.html

# Upload the frontend file
aws s3 cp frontend/index.html s3://codepocket-frontend-YOUR_UNIQUE_SUFFIX/ \
  --content-type "text/html"
```

### 3b. Set Bucket Policy (public read)

Create a file `bucket-policy.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::codepocket-frontend-YOUR_UNIQUE_SUFFIX/*"
  }]
}
```

Apply it:
```bash
aws s3api put-bucket-policy \
  --bucket codepocket-frontend-YOUR_UNIQUE_SUFFIX \
  --policy file://bucket-policy.json
```

### 3c. Create CloudFront Distribution

```bash
aws cloudfront create-distribution \
  --origin-domain-name codepocket-frontend-YOUR_UNIQUE_SUFFIX.s3-website-us-east-1.amazonaws.com \
  --default-root-object index.html
```

Note the **DomainName** from the output (e.g., `d1abc123.cloudfront.net`).  
Your frontend is now live at: `https://d1abc123.cloudfront.net`

---

## Step 4 — Deploy Backend to EC2

### 4a. Create an IAM Role for EC2 → DynamoDB

```bash
# Create the role
aws iam create-role \
  --role-name CodePocketEC2Role \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Principal":{"Service":"ec2.amazonaws.com"},
      "Action":"sts:AssumeRole"
    }]
  }'

# Attach DynamoDB policy
aws iam attach-role-policy \
  --role-name CodePocketEC2Role \
  --policy-arn arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess

# Create instance profile
aws iam create-instance-profile \
  --instance-profile-name CodePocketEC2Profile

aws iam add-role-to-instance-profile \
  --instance-profile-name CodePocketEC2Profile \
  --role-name CodePocketEC2Role
```

### 4b. Create a Security Group

```bash
aws ec2 create-security-group \
  --group-name codepocket-sg \
  --description "CodePocket API security group"

# Allow SSH (port 22) and HTTP (port 3000) and HTTPS (port 443)
aws ec2 authorize-security-group-ingress \
  --group-name codepocket-sg \
  --protocol tcp --port 22 --cidr 0.0.0.0/0

aws ec2 authorize-security-group-ingress \
  --group-name codepocket-sg \
  --protocol tcp --port 3000 --cidr 0.0.0.0/0

aws ec2 authorize-security-group-ingress \
  --group-name codepocket-sg \
  --protocol tcp --port 80 --cidr 0.0.0.0/0
```

### 4c. Launch EC2 Instance

```bash
aws ec2 run-instances \
  --image-id ami-0c02fb55956c7d316 \   # Amazon Linux 2023 (us-east-1)
  --instance-type t3.micro \           # Free tier eligible
  --key-name YOUR_KEY_PAIR_NAME \
  --security-groups codepocket-sg \
  --iam-instance-profile Name=CodePocketEC2Profile \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=CodePocketAPI}]'
```

Note the **PublicIpAddress** or **PublicDnsName** from the output.

### 4d. SSH Into EC2 and Deploy

```bash
ssh -i YOUR_KEY.pem ec2-user@YOUR_EC2_PUBLIC_IP

# On the EC2 instance:
# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs git

# Clone your project (or upload via scp)
git clone https://github.com/YOUR_USERNAME/codepocket.git
cd codepocket/backend

# Install dependencies
npm install

# Set environment variables
export AWS_REGION=us-east-1
export PORT=3000

# Start the server (keep alive with pm2)
sudo npm install -g pm2
pm2 start server.js --name "codepocket-api"
pm2 startup
pm2 save
```

Your API is now live at: `http://YOUR_EC2_PUBLIC_IP:3000`

---

## Step 5 — Set Up API Gateway

API Gateway provides a clean HTTPS URL and handles routing.

```bash
# Create the REST API
aws apigateway create-rest-api \
  --name "CodePocketAPI" \
  --description "CodePocket backend API"
```

Then in the AWS Console:
1. Go to **API Gateway → CodePocketAPI**
2. Create a resource: `/api/{proxy+}`
3. Create an `ANY` method → HTTP Proxy → point to `http://YOUR_EC2_IP:3000/{proxy}`
4. Deploy to a stage named `prod`
5. Copy the **Invoke URL** (e.g., `https://abc123.execute-api.us-east-1.amazonaws.com/prod`)

### Update frontend to use real API

In `frontend/index.html`, update line:
```javascript
const API_BASE = 'https://abc123.execute-api.us-east-1.amazonaws.com/prod';
```

Re-upload to S3:
```bash
aws s3 cp frontend/index.html s3://codepocket-frontend-YOUR_UNIQUE_SUFFIX/
```

Invalidate CloudFront cache:
```bash
aws cloudfront create-invalidation \
  --distribution-id YOUR_CF_DISTRIBUTION_ID \
  --paths "/*"
```

---

## Step 6 — Test Everything

```bash
# Health check
curl https://abc123.execute-api.us-east-1.amazonaws.com/prod/health

# Create a template
curl -X POST https://abc123.execute-api.us-east-1.amazonaws.com/prod/api/templates \
  -H "Content-Type: application/json" \
  -d '{"name":"Hello World","lang":"JavaScript","code":"console.log(\"hello\")","author":"testuser"}'

# Fetch templates
curl https://abc123.execute-api.us-east-1.amazonaws.com/prod/api/templates
```

---

## Cost Estimate (Free Tier)

| Service       | Free Tier Limit          | Overage Cost       |
|---------------|--------------------------|--------------------|
| EC2 t3.micro  | 750 hrs/month (1 yr)     | ~$0.0104/hr        |
| DynamoDB      | 25 GB + 25 RCU/WCU       | ~$1.25/million req |
| S3            | 5 GB + 20k GET requests  | ~$0.023/GB         |
| CloudFront    | 1 TB transfer/month (1yr)| ~$0.0085/GB        |
| API Gateway   | 1M calls/month (1 yr)    | ~$3.50/million     |

**Estimated monthly cost for a small app: $0–$5/month.**

---

## Quick Reference: All Your URLs

| What             | URL                                                |
|------------------|----------------------------------------------------|
| Frontend (web)   | `https://YOUR_CF_DOMAIN.cloudfront.net`            |
| API Base         | `https://YOUR_API_ID.execute-api.us-east-1.amazonaws.com/prod` |
| EC2 (direct)     | `http://YOUR_EC2_IP:3000`                          |
| DynamoDB Console | `https://console.aws.amazon.com/dynamodbv2`        |

---

## Troubleshooting

**EC2 unreachable?** Check security group allows port 3000/80.  
**DynamoDB access denied?** Verify IAM role is attached to EC2 instance.  
**CloudFront caching old frontend?** Run an invalidation (`/*`).  
**API Gateway 502?** EC2 server may be down — SSH in and run `pm2 status`.
