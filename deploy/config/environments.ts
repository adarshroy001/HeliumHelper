import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/** Everything that differs between deployed environments. Values marked `TODO(aws)` are placeholders. */
export interface EnvironmentConfig {
  readonly name: 'staging' | 'production';
  /** AWS account and region of every stack of this environment. */
  readonly account: string;
  readonly region: string;
  /** Prefix of resource names: `helium-staging-api`. */
  readonly prefix: string;
  /** The existing VPC (by ID, so `cdk synth` needs no AWS access) and the private subnets the services use. */
  readonly vpc: {
    readonly vpcId: string;
    readonly availabilityZones: readonly string[];
    readonly privateSubnetIds: readonly string[];
  };
  /** Security group of the existing DocumentDB cluster; the services' group is allowed in on 27017. */
  readonly documentDbSecurityGroupId: string;
  /** Who may reach the internal load balancer: HeliumAdmin's servers. */
  readonly callers: { readonly securityGroupIds: readonly string[]; readonly cidrs: readonly string[] };
  /** HTTPS on the load balancer when set (ACM certificate ARN); plain HTTP inside the VPC until then. */
  readonly certificateArn?: string;
  readonly api: ServiceSize & { readonly minCount: number; readonly maxCount: number };
  readonly worker: ServiceSize & { readonly minCount: number; readonly maxCount: number };
  readonly valkeyNodeType: string;
  readonly logRetention: RetentionDays;
  /** Gets alarm notifications until the Slack channel is connected (F26). */
  readonly alarmEmail?: string;
  /**
   * GitHub Actions' OIDC provider in this account: `create` it, or use the `existing` one (an account has at
   * most one; use `existing` when another stack or environment in the same account already created it).
   */
  readonly githubOidcProvider: 'create' | 'existing';
}

/** The repository whose workflows may deploy (F26). */
export const GITHUB_REPOSITORY = 'adarshroy001/HeliumHelper';

interface ServiceSize {
  /** Fargate CPU units: 256, 512, 1024 ... */
  readonly cpu: number;
  readonly memoryMiB: number;
}

const PLACEHOLDER_ACCOUNT = '000000000000';

export const ENVIRONMENTS: readonly EnvironmentConfig[] = [
  {
    name: 'staging',
    account: PLACEHOLDER_ACCOUNT, // TODO(aws): staging account ID
    region: 'ap-south-1',
    prefix: 'helium-staging',
    vpc: {
      vpcId: 'vpc-00000000000000000', // TODO(aws)
      availabilityZones: ['ap-south-1a', 'ap-south-1b'],
      privateSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'], // TODO(aws)
    },
    documentDbSecurityGroupId: 'sg-00000000000000001', // TODO(aws)
    callers: { securityGroupIds: ['sg-00000000000000002'], cidrs: [] }, // TODO(aws): HeliumAdmin's security group
    api: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 3 },
    worker: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 3 },
    valkeyNodeType: 'cache.t4g.small',
    logRetention: RetentionDays.TWO_WEEKS,
    githubOidcProvider: 'create',
  },
  {
    name: 'production',
    account: PLACEHOLDER_ACCOUNT, // TODO(aws): production account ID
    region: 'ap-south-1',
    prefix: 'helium-production',
    vpc: {
      vpcId: 'vpc-00000000000000000', // TODO(aws)
      availabilityZones: ['ap-south-1a', 'ap-south-1b'],
      privateSubnetIds: ['subnet-00000000000000001', 'subnet-00000000000000002'], // TODO(aws)
    },
    documentDbSecurityGroupId: 'sg-00000000000000001', // TODO(aws)
    callers: { securityGroupIds: ['sg-00000000000000002'], cidrs: [] }, // TODO(aws)
    api: { cpu: 1024, memoryMiB: 2048, minCount: 2, maxCount: 6 },
    worker: { cpu: 1024, memoryMiB: 2048, minCount: 2, maxCount: 6 },
    valkeyNodeType: 'cache.t4g.medium',
    logRetention: RetentionDays.THREE_MONTHS,
    githubOidcProvider: 'create', // TODO(aws): 'existing' if production shares staging's account
  },
];

/** `true` while an environment still has placeholder values: it can be synthesized, not deployed. */
export function hasPlaceholders(config: EnvironmentConfig): boolean {
  return config.account === PLACEHOLDER_ACCOUNT || JSON.stringify(config).includes('-0000000000000000');
}
