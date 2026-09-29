# Cloud on AWS: the DynamoDB store, the Lambda router, the stack

Owner's decisions so far: the whole cloud runs on AWS (2026-09-27); first
deploy uses API Gateway's own https address, no domain; nothing that costs
money is created without asking with the monthly cost; a $1 AWS Budgets alarm
goes up with the first deploy; the AWS SDK may be installed on this PC for
testing only (2026-09-29, `cloud/package.json`, dev dependencies).

Region `us-east-1`, CLI profile `camplat`. Austin signs in and runs every
command that touches his account; code in this repo never holds a credential.

This spec builds everything up to, and NOT including, a deploy. Four parts,
four owners:

## A. `cloud/api/dynamoKeys.mjs` (pure) and `cloud/api/dynamoStore.mjs` (I/O)

One table, on-demand billing, keys `pk` (string) and `sk` (string), a sparse
index `byCode` on `codeKey`, and TTL on `expiresAtS`.

| Record | pk | sk | Extra attributes |
|---|---|---|---|
| device | `DEV#<deviceId>` | `META` | `codeKey = <code>` ONLY while unclaimed with a code; `expiresAtS` as the Store gives it |
| latest check-in | `DEV#<deviceId>` | `CHECKIN` | `seq`, `atMs`, `payload` |
| tenancy | `INST#<installerId>` | `TENANCY` | `tenancy`, `version` |
| user | `USER#<login>` | `META` | |
| failed login | `FAIL#<key>` | `<id>` | `atMs`; `expiresAtS = ceil(atMs / 1000) + 86400` |
| session | `SESS#<tokenHash>` | `META` | `expiresAtS = ceil((createdMs + SESSION_MAX_MS) / 1000)` |

- **`dynamoKeys.mjs` is pure** (build rule 2): `toItem`/`fromItem` per record
  type, and the condition expression for every conditional write. `fromItem`
  strips every storage-only attribute (`pk`, `sk`, `codeKey`, and the
  `expiresAtS` the adapter adds to sessions and failed logins), so a getter
  returns exactly the Store shape. A device's own `expiresAtS` is Store data
  and round-trips.
- Every key takes an optional `keyPrefix` (default `""`), put in front of
  `pk` and `codeKey`. The conformance run uses a unique prefix per run, so a
  test never touches real records (build rule 21).
- **`dynamoStore.mjs`**: `createDynamoStore({ tableName, doc, keyPrefix })`,
  where `doc` is a `DynamoDBDocumentClient` (`@aws-sdk/lib-dynamodb`). It
  implements every method in `cloud/api/store.mjs`, with the same semantics
  `memoryStore.mjs` has and `storeConformance` checks:
  - conditional writes use `ConditionExpression`. A
    `ConditionalCheckFailedException` becomes `false` (or `"stale"` for
    `acceptCheckin`), never a throw. Every other error throws.
  - `acceptCheckin`: a conditional put, `attribute_not_exists(pk) OR seq <
    :seq`.
  - `lastSeqMap`: `BatchGet` in chunks of 100, retrying `UnprocessedKeys`
    with backoff, up to a bound; then throw.
  - `findDeviceByCode`: query `byCode` (an index read is eventually
    consistent), then a consistent `GetItem` of that device. Return it only
    if its `code` still equals the one asked for.
  - `failedLogins`: a consistent `Query` on `FAIL#<key>` with `sk >=` the
    zero-padded `sinceMs`. `clearFailedLogins`: query, then `BatchWrite`
    deletes in chunks of 25, retrying unprocessed items.
  - `deleteFailedLogin` / `deleteSession` report existence through
    `ReturnValues: "ALL_OLD"`.
  - every read that decides something is `ConsistentRead: true`.
- A tenancy item must stay under DynamoDB's 400 KB item limit. Refuse a
  `putTenancy` whose serialized size is over 350 KB with a clear error. That
  is thousands of sites; splitting the tree is later work.

## B. `cloud/lambda/router.mjs`

One Lambda serves every route (API Gateway HTTP API, payload format 2.0).

- `createRouter(deps)` returns `route(apiGatewayEvent)`. It is testable with
  the memory store. `handler` is `createRouter` wired once per cold start to
  `createDynamoStore` over the runtime's own SDK, `TABLE_NAME` from the
  environment, and `Date.now` / `randomBytes` / JSON-line `console.log`.
- **Event in:**
  - `body`: base64-decoded when `isBase64Encoded`, else the string, else `""`;
  - `headers`: lower-case names (API Gateway already sends them so);
  - `event.cookies` joined with `"; "` into `headers.cookie`;
  - `sourceIp` from `requestContext.http.sourceIp`.
  - A body over 16 KB (the dev server's limit) -> 413 `payload_too_large`
    before any handler runs.
- **Routes** by `routeKey`: `POST /enroll`, `POST /checkin`, `POST /claim`,
  `GET /fleet`, `POST /login`, `POST /logout`. Anything else -> 404
  `not_found`.
  - Each handler gets the deps `cloud/dev/server.mjs` gives it, minus every
    dev-only piece: no dev token, no site-dev glue.
  - `allowOpenEnrollment: true` is the owner's production decision.
  - `principalOf` for `/claim` and `/fleet` is `principalFromEvent`.
- **Response out:** `{ statusCode, headers, body }`, with a `set-cookie`
  header moved into the `cookies` array (the 2.0 format's way).
- A handler that throws -> 500 `internal`, logged as one line with the route
  and the error message only. Never the event, the body or the headers:
  they carry passwords, cookies and claim codes.

## C. `cloud/deploy/`: the stack and the scripts Austin runs

- **`stack.yaml`** (CloudFormation), one stack per stage (`camplat-dev`):
  - the table from section A (`PAY_PER_REQUEST`, TTL on `expiresAtS`, index
    `byCode` with `KEYS_ONLY` projection, point-in-time recovery off,
    `DeletionPolicy: Delete` for dev);
  - a log group with 14-day retention;
  - the function:
    - `nodejs24.x`, `arm64`, 256 MB, 10 s timeout;
    - handler `cloud/lambda/router.handler`;
    - `LoggingConfig` `JSON` with system log level `WARN` (drops the
      per-request START/END lines that cost log volume);
    - `TABLE_NAME` in its environment;
    - inline placeholder code (the real zip is uploaded by the deploy
      script, so no S3 bucket is needed).
  - a least-privilege role: DynamoDB get, put, update, delete, query,
    batch-get and batch-write on THIS table and its index only; writes to
    THIS log group only;
  - the HTTP API:
    - the six routes, a proxy integration with payload 2.0, and the
      `$default` stage with auto-deploy;
    - throttling: default burst 20 / rate 10; `POST /enroll` burst 5 /
      rate 1; `POST /login` burst 5 / rate 2 (this bounds the login lockout
      limit noted in CLOUD-LOGIN-SPEC.md section G);
    - no CORS;
  - an `AWS::Budgets::Budget`: monthly, COST, limit `BudgetLimitUsd`
    (default 1). Email `BudgetEmail` (a parameter Austin types) when ACTUAL
    passes 80% and when FORECASTED passes 100%;
  - outputs: the API URL, the table name, the function name.
- **`package.mjs`**: builds the cloud (`tsc`), then writes
  `cloud/deploy/out/camplat-api.zip` containing exactly the files the
  router's import graph needs. No `node_modules`, no footage, no keys, no
  `.pem`.
  - Entry names use forward slashes: Windows PowerShell 5.1's
    `Compress-Archive` writes backslashes and breaks Lambda. Use Windows'
    own `C:\Windows\System32\tar.exe -a` (bsdtar), or a small zip writer
    in Node.
  - It then extracts the zip into a temp folder and imports the router from
    there, proving nothing is missing.
- **`deploy.ps1`**, **`teardown.ps1`**, **`smoke.mjs`**:
  - `deploy.ps1` runs `aws cloudformation deploy` (with `--profile
    camplat`), then `aws lambda update-function-code --zip-file`, and prints
    the API URL.
  - `teardown.ps1` deletes the stack and waits.
  - `smoke.mjs <apiUrl>` only reads or gets refused. It checks:
    - `GET /fleet` with no cookie -> 401;
    - a bad login -> 401;
    - an unknown route -> 404.

    It never creates a user or a device.
  - The scripts call `aws.exe` by its full path (see memory
    `aws-toolkit-setup`) and set `PYTHONUTF8=1`.

## D. Tests (written first)

- **`cloud/harness/dynamoKeys.harness.mjs`**:
  - every record type round-trips through `toItem`/`fromItem` unchanged;
  - no storage attribute leaks into a returned record;
  - a claimed device has no `codeKey`, and an unclaimed one with a code has
    it;
  - a session and a failed login carry the TTL they must;
  - the `keyPrefix` lands on `pk` and `codeKey` and nowhere else.
- **`cloud/harness/lambdaRouter.harness.mjs`**, over the memory store:
  - the whole loop through API Gateway 2.0 events: login, enrol, claim with
    the cookie, the setup tool's `assign-device`, check in, fleet online;
  - `set-cookie` arrives in `cookies`;
  - `event.cookies` reaches the handlers;
  - a base64 body decodes;
  - 413 over 16 KB, 404 for an unknown route;
  - a throwing handler gives 500, and its log line has no body, header or
    cookie;
  - no dev token works.
- **`storeConformance.harness.mjs`** also runs against DynamoDB when
  `CAMPLAT_STORE=dynamo CAMPLAT_DDB_TABLE=<name>` are set.
  - It uses a fresh `keyPrefix` per run and deletes every item it wrote,
    in a `finally`.
  - Without those variables it runs the memory store only, and says so in
    one line.
  - Running it for real needs a table on AWS: that is its own ask to Austin
    with the cost. Until then the adapter is "built, conformance NOT run on
    DynamoDB", and every report says exactly that.
- **`package.mjs`** proves its own zip, as above.

## E. Out of scope here

- The deploy itself (asked separately, with the cost).
- The domain, the viewer website, the relay.
- Bundling the SDK: AWS recommends shipping the SDK modules inside the
  deployment package for backward compatibility. We use the runtime's copy,
  as told to Austin. Revisit it if a runtime update ever breaks the adapter.
