// cloud/harness/deployStack.harness.mjs — cloud/deploy/stack.yaml and
// cloud/deploy/package.mjs (CLOUD-AWS-SPEC.md section C). Offline only: no
// aws CLI call, no AWS resource touched, deploy.ps1/teardown.ps1 never run.
//
// FEARED: stack.yaml drifting from what cloud/lambda/router.mjs actually
// serves (a seventh route added to the router that the stack never wires,
// or a route renamed in one file and not the other); a DynamoDB policy
// that quietly widens to Resource: "*" during some later edit; a stray
// NAT gateway, load balancer, RDS instance or Elastic IP creeping into a
// stack that is supposed to be table + function + HTTP API + budget, only
// (AWS-AGENT-RULES.md: pay-per-request only, nothing billed hourly without
// asking); package.mjs's own zip-build-and-import proof silently rotting.
//
// stack.yaml is checked as raw text -- no YAML parser is available in this
// project (cloud/node_modules has @aws-sdk and its own transitive deps
// only, no js-yaml/yaml, confirmed this session) -- so this is deliberately
// a parser-free structural check, not a real YAML parse.

import { check, eq, same, report } from "../../harness/_assert.mjs";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

console.log("deploy stack");

const HERE = path.dirname(fileURLToPath(import.meta.url)); // camera-platform/cloud/harness
const CLOUD_DIR = path.resolve(HERE, "..");
const ROOT_DIR = path.resolve(CLOUD_DIR, "..");
const STACK_PATH = path.join(CLOUD_DIR, "deploy", "stack.yaml");
const ROUTER_PATH = path.join(CLOUD_DIR, "lambda", "router.mjs");

const stackText = readFileSync(STACK_PATH, "utf8");

/** True if `  <id>:` starts a top-level-indented (2-space) mapping key --
 *  i.e. `<id>` is a resource's own logical ID under `Resources:`. */
function hasLogicalId(id) {
  return new RegExp(`^  ${id}:\\s*$`, "m").test(stackText);
}

/** The text between `startMarker` (its first occurrence) and the next
 *  occurrence of `endMarkerRe` after it (or end of file). Used to scope a
 *  check to one IAM statement, one resource block, etc., without a real
 *  YAML parser. */
function sectionAfter(text, startMarker, endMarkerRe) {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`marker not found in stack.yaml: "${startMarker}"`);
  const rest = text.slice(startIdx + startMarker.length);
  if (!endMarkerRe) return rest;
  const m = endMarkerRe.exec(rest);
  return m ? rest.slice(0, m.index) : rest;
}

await check("every required resource's logical ID is present", () => {
  for (const id of [
    "Table",
    "FunctionLogGroup",
    "ExecutionRole",
    "RouterFunction",
    "HttpApi",
    "LambdaIntegration",
    "ApiStage",
    "LambdaInvokePermission",
    "Budget",
  ]) {
    eq(hasLogicalId(id), true, `Resources.${id} exists`);
  }
});

await check("parameters: Stage default dev, BudgetEmail no default + email-shaped AllowedPattern, BudgetLimitUsd default 1", () => {
  const params = sectionAfter(stackText, "Parameters:", /^Resources:/m);
  eq(/Stage:[\s\S]{0,80}?Default:\s*dev/.test(params), true, "Stage default dev");
  const budgetEmail = sectionAfter(params, "BudgetEmail:", /^  \w+:/m);
  eq(/Default:/.test(budgetEmail), false, "BudgetEmail has no Default");
  eq(/AllowedPattern:/.test(budgetEmail), true, "BudgetEmail has an AllowedPattern");
  eq(/@/.test(budgetEmail.match(/AllowedPattern:\s*"([^"]*)"/)?.[1] ?? ""), true, "the AllowedPattern itself mentions @ (email-shaped)");
  eq(/BudgetLimitUsd:[\s\S]{0,80}?Default:\s*1\b/.test(params), true, "BudgetLimitUsd default 1");
});

await check("the function: nodejs24.x, arm64, 256 MB, 10s, the real handler path", () => {
  eq(/Runtime:\s*nodejs24\.x/.test(stackText), true, "Runtime nodejs24.x");
  eq(/Architectures:\s*\n\s*-\s*arm64/.test(stackText), true, "Architectures: [arm64]");
  eq(/MemorySize:\s*256\b/.test(stackText), true, "MemorySize 256");
  eq(/Timeout:\s*10\b/.test(stackText), true, "Timeout 10");
  eq(/Handler:\s*cloud\/lambda\/router\.handler/.test(stackText), true, "Handler cloud/lambda/router.handler");
});

await check("LoggingConfig: JSON format, WARN system level, INFO application level, the stack's own log group", () => {
  const fn = sectionAfter(stackText, "RouterFunction:", /^  \w+:\n {4}Type:/m);
  eq(/LoggingConfig:[\s\S]{0,160}?LogFormat:\s*JSON/.test(fn), true, "LogFormat JSON");
  eq(/LoggingConfig:[\s\S]{0,160}?SystemLogLevel:\s*WARN/.test(fn), true, "SystemLogLevel WARN");
  eq(/LoggingConfig:[\s\S]{0,160}?ApplicationLogLevel:\s*INFO/.test(fn), true, "ApplicationLogLevel INFO");
  eq(/LoggingConfig:[\s\S]{0,160}?LogGroup:\s*!Ref FunctionLogGroup/.test(fn), true, "LogGroup points at FunctionLogGroup");
  eq(/RetentionInDays:\s*14\b/.test(stackText), true, "the log group's own retention is 14 days");
});

await check("the DynamoDB policy statement never grants Resource: \"*\", and names this table + its index only", () => {
  const dynamoStmt = sectionAfter(stackText, "Sid: DynamoAccess", /Sid:\s*LogsAccess/);
  eq(/(^|\n)\s*-\s*['"]?\*['"]?\s*(\n|$)/.test(dynamoStmt), false, "no bare * Resource entry");
  eq(dynamoStmt.includes("!GetAtt Table.Arn"), true, "grants the table's own ARN");
  eq(dynamoStmt.includes("index/byCode"), true, "grants the byCode index's own ARN");
  for (const action of ["GetItem", "PutItem", "UpdateItem", "DeleteItem", "Query", "BatchGetItem", "BatchWriteItem"]) {
    eq(dynamoStmt.includes(`dynamodb:${action}`), true, `grants dynamodb:${action}`);
  }
});

await check("the logs policy statement is scoped to this function's own log group, not logs:*", () => {
  const logsStmt = sectionAfter(stackText, "Sid: LogsAccess", /^\s{4}#|\n  \w+:\n {4}Type:/m);
  eq(logsStmt.includes("${FunctionLogGroup}"), true, "resource references FunctionLogGroup by name, not a wildcard log-group ARN");
  eq(/(^|\n)\s*-\s*['"]?\*['"]?\s*(\n|$)/.test(logsStmt), false, "no bare * Resource entry");
});

await check("the table: PAY_PER_REQUEST, TTL on expiresAtS, byCode GSI KEYS_ONLY on codeKey, DeletionPolicy/UpdateReplacePolicy Delete", () => {
  const table = sectionAfter(stackText, "Table:\n", /^  \w+:\n {4}Type:/m);
  eq(/DeletionPolicy:\s*Delete/.test(table), true, "DeletionPolicy Delete");
  eq(/UpdateReplacePolicy:\s*Delete/.test(table), true, "UpdateReplacePolicy Delete");
  eq(/BillingMode:\s*PAY_PER_REQUEST/.test(table), true, "PAY_PER_REQUEST");
  eq(/TimeToLiveSpecification:[\s\S]{0,60}?AttributeName:\s*expiresAtS/.test(table), true, "TTL attribute expiresAtS");
  eq(/TimeToLiveSpecification:[\s\S]{0,80}?Enabled:\s*true/.test(table), true, "TTL enabled");
  eq(/IndexName:\s*byCode/.test(table), true, "GSI named byCode");
  eq(/IndexName:\s*byCode[\s\S]{0,200}?ProjectionType:\s*KEYS_ONLY/.test(table), true, "byCode is KEYS_ONLY");
  eq(/KeyType:\s*HASH[\s\S]{0,0}/.test(table) || table.includes("AttributeName: pk"), true, "pk is a key attribute");
  eq(table.includes("AttributeName: sk"), true, "sk is a key attribute");
});

await check("the six routes each get an AWS_PROXY / payload 2.0 integration", () => {
  eq(/IntegrationType:\s*AWS_PROXY/.test(stackText), true, "AWS_PROXY");
  eq(/PayloadFormatVersion:\s*"2\.0"/.test(stackText), true, "payload format 2.0");
  for (const rk of ["POST /enroll", "POST /checkin", "POST /claim", "GET /fleet", "POST /login", "POST /logout"]) {
    eq(stackText.includes(`RouteKey: "${rk}"`), true, `route ${rk} is wired`);
  }
});

await check("throttling: default burst 20 / rate 10; POST /enroll burst 5 / rate 1; POST /login burst 5 / rate 2", () => {
  const stage = sectionAfter(stackText, "ApiStage:", /^  \w+:\n {4}Type:/m);
  eq(/DefaultRouteSettings:[\s\S]{0,80}?ThrottlingBurstLimit:\s*20/.test(stage), true, "default burst 20");
  eq(/DefaultRouteSettings:[\s\S]{0,80}?ThrottlingRateLimit:\s*10/.test(stage), true, "default rate 10");
  eq(/"POST \/enroll":\s*\n\s*ThrottlingBurstLimit:\s*5\s*\n\s*ThrottlingRateLimit:\s*1\b/.test(stage), true, "enroll burst 5 / rate 1");
  eq(/"POST \/login":\s*\n\s*ThrottlingBurstLimit:\s*5\s*\n\s*ThrottlingRateLimit:\s*2\b/.test(stage), true, "login burst 5 / rate 2");
  eq(/AutoDeploy:\s*true/.test(stage), true, "$default stage auto-deploys");
});

await check("no CORS configuration exists on the HTTP API", () => {
  eq(/CorsConfiguration/.test(stackText), false, "no CorsConfiguration anywhere");
});

await check("the Lambda permission is scoped to this API, not a bare wildcard", () => {
  const perm = sectionAfter(stackText, "LambdaInvokePermission:", /^  \w+:\n {4}Type:/m);
  eq(/SourceArn:\s*!Sub/.test(perm), true, "SourceArn is built from this stack's own API");
  eq(perm.includes("${HttpApi}"), true, "SourceArn references HttpApi by ID, not *");
});

await check("the budget: monthly COST, ACTUAL > 80%, FORECASTED > 100%, both notify BudgetEmail", () => {
  const budget = sectionAfter(stackText, "Budget:\n", /^Outputs:/m);
  eq(/BudgetType:\s*COST/.test(budget), true, "COST");
  eq(/TimeUnit:\s*MONTHLY/.test(budget), true, "MONTHLY");
  eq(/NotificationType:\s*ACTUAL[\s\S]{0,120}?Threshold:\s*80\b/.test(budget), true, "ACTUAL > 80%");
  eq(/NotificationType:\s*FORECASTED[\s\S]{0,140}?Threshold:\s*100\b/.test(budget), true, "FORECASTED > 100%");
  const emailRefs = (budget.match(/!Ref BudgetEmail/g) ?? []).length;
  eq(emailRefs, 2, "both notifications reference BudgetEmail");
});

await check("outputs: ApiUrl, TableName, FunctionName", () => {
  const outputs = sectionAfter(stackText, "Outputs:", null);
  for (const id of ["ApiUrl", "TableName", "FunctionName"]) {
    eq(new RegExp(`^  ${id}:\\s*$`, "m").test(outputs), true, `Outputs.${id} exists`);
  }
});

await check("no NAT gateway, load balancer, RDS, EC2 instance, or Elastic IP resource type appears", () => {
  const forbidden = [
    /AWS::EC2::NatGateway/,
    /AWS::EC2::Instance\b/,
    /AWS::EC2::EIP\b/,
    /AWS::ElasticLoadBalancing/, // covers classic ELB and ELBv2 (ALB/NLB)
    /AWS::RDS::/,
  ];
  for (const re of forbidden) {
    eq(re.test(stackText), false, `stack.yaml must not contain a resource matching ${re}`);
  }
});

await check("stack.yaml's routes equal EXACTLY the routes cloud/lambda/router.mjs serves -- no more, no fewer", () => {
  const routerText = readFileSync(ROUTER_PATH, "utf8");
  const caseRe = /case\s+"([^"]+)":/g;
  const routerRoutes = new Set();
  let m;
  while ((m = caseRe.exec(routerText))) routerRoutes.add(m[1]);
  eq(routerRoutes.size >= 1, true, "router.mjs's switch has at least one case");

  const stackRouteRe = /RouteKey:\s*"([^"]+)"/g;
  const stackRoutes = new Set();
  while ((m = stackRouteRe.exec(stackText))) stackRoutes.add(m[1]);
  same([...routerRoutes].sort(), [...stackRoutes].sort(), "router.mjs's case labels == stack.yaml's RouteKeys");
});

// A catch-all route sends every bot probing a random path to the function,
// and each of those is a billed Lambda invocation. API Gateway's own 404 is
// free of that.
// A named IAM resource needs CAPABILITY_NAMED_IAM; deploy.ps1 passes only
// CAPABILITY_IAM, so a RoleName would make the first deploy fail.
await check("IAM capability matches: no named IAM resource unless deploy.ps1 passes CAPABILITY_NAMED_IAM", () => {
  const deployText = readFileSync(path.join(CLOUD_DIR, "deploy", "deploy.ps1"), "utf8");
  const named = /^\s+(RoleName|PolicyName|UserName|GroupName|InstanceProfileName|ManagedPolicyName):/m.test(
    stackText.replace(/- PolicyName:[^\n]*/g, ""), // an inline policy's name is not a named IAM resource
  );
  eq(named && !deployText.includes("CAPABILITY_NAMED_IAM"), false, "a named IAM resource with only CAPABILITY_IAM");
});

// RouteSettings refers to routes by key; without DependsOn the stage can be
// created first and CloudFormation fails with "Unable to find Route by key".
await check("the stage waits for every route its RouteSettings names", () => {
  const stage = stackText.slice(stackText.indexOf("ApiStage:"), stackText.indexOf("LambdaInvokePermission:"));
  for (const r of ["RouteEnroll", "RouteLogin"]) eq(new RegExp(`DependsOn:[\\s\\S]*- ${r}\\b`).test(stage), true, `ApiStage DependsOn ${r}`);
});

await check('no "$default" catch-all route: unknown paths never invoke the function', () => {
  eq(/RouteKey:\s*"?\$default"?/.test(stackText), false, "no $default route in stack.yaml");
});

await check("package.mjs builds the zip and passes its own extraction/import proof", () => {
  const r = spawnSync(process.execPath, [path.join(CLOUD_DIR, "deploy", "package.mjs")], {
    cwd: ROOT_DIR,
    stdio: "inherit",
    timeout: 300000,
  });
  if (r.error) throw r.error;
  eq(r.status, 0, `node cloud/deploy/package.mjs exited ${r.status}`);
});

report("deploy stack");
