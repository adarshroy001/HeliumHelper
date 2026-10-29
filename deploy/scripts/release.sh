#!/usr/bin/env bash
# Releases one image to one environment, in the safe order (docs/RUNBOOK.md):
#   1. the base stacks (foundation, data) - usually no change;
#   2. the migration task on the new image, then run it and wait; stop here if it fails;
#   3. the services on the new image (ECS rolls back by itself if the new tasks don't become healthy).
#
# Usage: deploy/scripts/release.sh <staging|production> <image tag (the git commit SHA)>
# Needs AWS credentials for the environment's account (the pipeline's deploy role) and the image already pushed.
set -euo pipefail

ENVIRONMENT="${1:?environment: staging or production}"
TAG="${2:?image tag}"
PREFIX="helium-${ENVIRONMENT}"
CDK=(pnpm exec cdk --require-approval never --context "imageTag=${TAG}")

echo "== Releasing ${TAG} to ${ENVIRONMENT}"

echo "== 1/3 Base stacks"
"${CDK[@]}" deploy --exclusively "${PREFIX}-foundation" "${PREFIX}-data"

echo "== 2/3 Migrations"
"${CDK[@]}" deploy --exclusively "${PREFIX}-migration"
output() {
  aws cloudformation describe-stacks --stack-name "${PREFIX}-migration" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
CLUSTER="$(output ClusterName)"
TASK_ARN="$(aws ecs run-task \
  --cluster "${CLUSTER}" \
  --task-definition "$(output TaskDefinitionArn)" \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$(output Subnets)],securityGroups=[$(output SecurityGroup)],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"
echo "migration task: ${TASK_ARN}"
aws ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}"
EXIT_CODE="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
if [ "${EXIT_CODE}" != "0" ]; then
  echo "Migrations failed (exit code ${EXIT_CODE}). Logs: CloudWatch /helium/${ENVIRONMENT}/migrate. Services not changed." >&2
  exit 1
fi

echo "== 3/3 Services"
"${CDK[@]}" deploy --exclusively "${PREFIX}-services"

echo "== Released ${TAG} to ${ENVIRONMENT}"
