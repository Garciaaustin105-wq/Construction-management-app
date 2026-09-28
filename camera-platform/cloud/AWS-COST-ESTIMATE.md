# AWS monthly cost estimate (2026-09-28)

Prices read on 2026-09-28 from AWS's own pricing pages (us-east-1), each
re-checked by a second pass against the live pages and AWS's Price List API:
no arithmetic or price errors found. Nothing was created in AWS to make it.

## The workload priced

- Each NVR checks in every 60 s: API Gateway HTTP API -> one Lambda (Node.js,
  128 MB, ~60 ms) -> DynamoDB on-demand, 1 conditional write + 1 read.
  43,800 check-ins per NVR per month.
- Fleet dashboard: ~50 page loads per NVR per month.
- Static website on S3 + CloudFront (~50 MB/month per site).
- CloudWatch Logs, ~200 bytes per request, 7-day retention.
- One Route 53 hosted zone (the per-NVR local names) and one .com domain.
- **Not priced yet:** the video relay (TURN), the last resort only.

## Monthly cost

| NVRs | Total / month | After always-free allowances |
|---:|---:|---:|
| 1 | $0.60 | $0.53 |
| 10 | $1.50 | $0.83 |
| 100 | $10.53 | $7.91 |
| 1,000 | $106.40 | $92.97 |

Plus the .com domain: **$16.00 / year** (Route 53, from 2026-07-01). ACM
certificates: free. The Route 53 hosted zone ($0.50/month) is the only flat
monthly line and is included above.

At 1,000 NVRs: API Gateway requests $43.85, DynamoDB writes $27.38, DynamoDB
reads $11.72, Lambda $14.25, CloudFront $4.25, CloudWatch Logs $4.44.

## What drives it

The 60-second check-in. At 1,000 NVRs, check-in requests and their DynamoDB
writes are about two-thirds of the bill. A 5-minute check-in would cut those
lines about five-fold (the fleet's "online" window would widen to match --
cloud/contracts/fleet.ts uses 2.5 intervals).

## Free tier notes

- New account (created 2026-09): up to $200 in credits for 6 months, covering
  every scenario above many times over.
- Always free, any account age: Lambda 1M requests + 400,000 GB-s per month;
  CloudFront 1 TB + 10M requests per month; CloudWatch Logs 5 GB per month;
  DynamoDB 25 GB storage.
- API Gateway HTTP API: 1M requests/month free for the first 12 months only.
- DynamoDB on-demand read/write units have **no** documented free allowance;
  they are billed from the first request.

## Sources

api-gateway/pricing, lambda/pricing, dynamodb/pricing/on-demand, s3/pricing,
cloudfront/pricing/pay-as-you-go, cloudwatch/pricing, route53/pricing (all
aws.amazon.com), and the Route 53 domain-pricing PDF.
