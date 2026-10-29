# ADR-0011 · Hosting: ECS Fargate, Lambda for webhook intake, CDK

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

- The API and workers run continuously, hold database connections, and must scale independently.
- Webhook intake is bursty: a campaign can produce thousands of webhooks a second. It must answer the provider in milliseconds.
- Today everything runs with pm2 on EC2 boxes, scaled and deployed by hand.

## Decision

- **Region:** AWS ap-south-1, next to the existing VPC and DocumentDB.
- **ECS on Fargate, ARM64 (Graviton), for the API and every worker service.**
    - One Docker image; the command and `WORKER_QUEUES` decide the role.
    - The API sits behind an internal ALB.
    - Deployments use the circuit breaker with automatic rollback.
- **AWS Lambda for webhook intake only.** Handlers in `src/lambdas/` verify the signature, put the event on SQS and return 200, with no database. They are bundled separately from the same repo.
- **Infrastructure as code with AWS CDK (TypeScript)** in `deploy/`. Nothing is created by hand in the console.
- **Secrets in AWS Secrets Manager,** injected by ECS and Lambda. Never in images or committed files.
- **Deploys through GitHub Actions with OIDC to AWS** (no long-lived keys):
    - staging on merge;
    - production after manual approval;
    - migrations run before the new code starts.

## Alternatives considered

- **EC2 with pm2:** a single box, manual scaling, manual deploys.
- **Lambda for everything:** 15-minute limit; every concurrent function opens its own database connections; a poor fit for paced, continuous senders.
- **Kubernetes (EKS):** far more to operate than we need.
- **Terraform:** a second language. The team writes TypeScript.

## Consequences

- Fargate costs more per CPU-hour than raw EC2. In exchange, nobody patches servers and scaling is automatic.
- F23–F26 build this. Until then everything runs locally.
