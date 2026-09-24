"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

test("production Nginx example enforces HTTPS, safe proxy identity, uploads, compression, and caching", () => {
  const config = fs.readFileSync(
    path.join(root, "deploy", "nginx", "competition-platform.conf"),
    "utf8"
  );
  assert.match(config, /return 301 https:\/\/\$host\$request_uri;/u);
  assert.match(config, /client_max_body_size 64m;/u);
  assert.match(config, /Strict-Transport-Security "max-age=31536000" always;/u);
  assert.match(config, /server_tokens off;/u);
  assert.match(config, /gzip on;/u);
  assert.match(config, /gzip_vary on;/u);
  assert.match(config, /gzip_proxied any;/u);
  assert.match(config, /text\/css/u);
  assert.match(config, /application\/javascript/u);
  assert.match(config, /proxy_set_header X-Forwarded-For \$remote_addr;/u);
  assert.match(config, /proxy_set_header CF-Connecting-IP "";/u);
  assert.match(config, /proxy_pass http:\/\/chenlong_competition_platform;/u);
  assert.match(config, /public, max-age=31536000, immutable/u);
  assert.match(config, /public, max-age=86400/u);
  assert.match(config, /proxy_read_timeout 130s;/u);
  assert.match(config, /proxy_set_header Range \$http_range;/u);
  assert.match(config, /proxy_set_header If-Range \$http_if_range;/u);
});

test("Docker deployment is loopback-only by default and forwards bounded settings without embedding secrets", () => {
  const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
  const environment = fs.readFileSync(path.join(root, "docker.env.example"), "utf8");
  assert.match(
    compose,
    /\$\{COMPETITION_PLATFORM_BIND_ADDRESS:-127\.0\.0\.1\}:\$\{COMPETITION_PLATFORM_PORT:-6190\}:6190/u
  );
  assert.match(environment, /^COMPETITION_PLATFORM_BIND_ADDRESS=127\.0\.0\.1$/mu);
  assert.match(compose, /CHENLONG_RUN_ARCHIVE_MAX_BYTES/u);
  assert.match(compose, /CHENLONG_SCORE_DOWNLOAD_TRUSTED_PROXIES/u);
  assert.match(environment, /CHENLONG_RUN_ARCHIVE_MAX_BYTES=4294967296/u);
  assert.doesNotMatch(environment, /^CHENLONG_OFFICIAL_SSO_SECRET=.+$/mu);
});

test("official API Compose overrides keep secrets read-only and runtime state persistent", () => {
  const override = fs.readFileSync(
    path.join(root, "deploy", "compose.official-api.yaml"),
    "utf8"
  );
  const snapshotOverride = fs.readFileSync(
    path.join(root, "deploy", "compose.official-score-snapshot.yaml"),
    "utf8"
  );
  const environment = fs.readFileSync(path.join(root, "docker.env.example"), "utf8");

  assert.match(override, /CHENLONG_SCORE_DOWNLOAD_APPS_HOST_FILE:\?/u);
  assert.match(override, /target: \/run\/secrets\/score-download-apps\.json/u);
  assert.match(override, /CHENLONG_SCORE_DOWNLOAD_CONFIG_HOST_DIR:\?/u);
  assert.match(override, /target: \/run\/official-score/u);
  assert.equal((override.match(/read_only: true/gu) || []).length, 2);
  assert.match(override, /CHENLONG_SCORE_DOWNLOAD_APPS_FILE: \/run\/secrets\/score-download-apps\.json/u);
  assert.match(override, /CHENLONG_SCORE_DOWNLOAD_PROMOTIONS_FILE: \/run\/official-score\/promotions\.json/u);
  assert.match(override, /CHENLONG_SCORE_DOWNLOAD_RUNTIME_DIR: \/app\/projects\/car-python\/\.runtime\/score-download/u);
  assert.match(snapshotOverride, /CHENLONG_SCORE_DOWNLOAD_SNAPSHOT_PATH: \/run\/official-score\/frozen-score-snapshot\.json/u);
  assert.match(environment, /CHENLONG_SCORE_DOWNLOAD_APPS_HOST_FILE/u);
  assert.match(environment, /CHENLONG_SCORE_DOWNLOAD_CONFIG_HOST_DIR/u);
});

test("Docker health checks require every competition subsystem to be ready", () => {
  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  const compose = fs.readFileSync(path.join(root, "compose.yaml"), "utf8");
  assert.match(dockerfile, /127\.0\.0\.1:6190\/api\/readiness/u);
  assert.match(compose, /127\.0\.0\.1:6190\/api\/readiness/u);
});
