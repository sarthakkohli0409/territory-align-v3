CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS districts (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS territories (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) UNIQUE NOT NULL,
  district_id INTEGER REFERENCES districts(id),
  color       VARCHAR(7) DEFAULT '#378ADD',
  idx1        DECIMAL(12,2) DEFAULT 0,
  idx2        DECIMAL(12,2) DEFAULT 0,
  idx3        DECIMAL(12,2) DEFAULT 0,
  idx4        DECIMAL(12,2) DEFAULT 0,
  hco_count   INTEGER DEFAULT 0,
  zip_count   INTEGER DEFAULT 0,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  personnel_id  VARCHAR(10) UNIQUE NOT NULL,
  name          VARCHAR(200) NOT NULL,
  role          VARCHAR(5) NOT NULL CHECK (role IN ('NSD','DM','OAM')),
  territory_id  INTEGER REFERENCES territories(id),
  district_id   INTEGER REFERENCES districts(id),
  password_hash VARCHAR(200) NOT NULL,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS versions (
  id              SERIAL PRIMARY KEY,
  version_label   VARCHAR(10) UNIQUE NOT NULL,
  description     TEXT,
  uploaded_by     INTEGER REFERENCES users(id),
  zip_count       INTEGER DEFAULT 0,
  hcp_count       INTEGER DEFAULT 0,
  territory_count INTEGER DEFAULT 0,
  is_current      BOOLEAN DEFAULT FALSE,
  upload_mode     VARCHAR(10) DEFAULT 'replace' CHECK (upload_mode IN ('append','replace')),
  created_at      TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS zips (
  id           SERIAL PRIMARY KEY,
  code         VARCHAR(10) NOT NULL,
  city         VARCHAR(100),
  territory_id INTEGER REFERENCES territories(id),
  district_id  INTEGER REFERENCES districts(id),
  version_id   INTEGER REFERENCES versions(id),
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hcps (
  id           SERIAL PRIMARY KEY,
  hcp_id       VARCHAR(20) UNIQUE NOT NULL,
  name         VARCHAR(200),
  city         VARCHAR(100),
  state        VARCHAR(2),
  zip          VARCHAR(10),
  territory_id INTEGER REFERENCES territories(id),
  district_id  INTEGER REFERENCES districts(id),
  tier         VARCHAR(10) DEFAULT 'Tier 1',
  idx1         DECIMAL(12,4) DEFAULT 0,
  idx2         DECIMAL(12,4) DEFAULT 0,
  idx3         DECIMAL(12,4) DEFAULT 0,
  idx4         DECIMAL(12,4) DEFAULT 0,
  version_id   INTEGER REFERENCES versions(id),
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS requests (
  id                SERIAL PRIMARY KEY,
  request_id        VARCHAR(20) UNIQUE NOT NULL,
  type              VARCHAR(50) NOT NULL,
  status            VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  priority          VARCHAR(10) DEFAULT 'Normal' CHECK (priority IN ('Normal','High','Urgent')),
  requester_id      INTEGER REFERENCES users(id),
  approver_id       INTEGER REFERENCES users(id),
  src_territory_id  INTEGER REFERENCES territories(id),
  dest_territory_id INTEGER REFERENCES territories(id),
  hcp_zip           VARCHAR(50),
  reason            VARCHAR(50),
  comment           TEXT,
  before_state      JSONB,
  after_state       JSONB,
  has_conflict      BOOLEAN DEFAULT FALSE,
  conflict_msg      TEXT,
  rejection_reason  TEXT,
  resolved_at       TIMESTAMP,
  created_at        TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_comments (
  id         SERIAL PRIMARY KEY,
  request_id INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  comment    TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  action       VARCHAR(50) NOT NULL,
  detail       TEXT,
  before_state JSONB,
  after_state  JSONB,
  district     VARCHAR(100),
  version_id   INTEGER REFERENCES versions(id),
  ip_address   VARCHAR(45),
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conflicts (
  id            SERIAL PRIMARY KEY,
  type          VARCHAR(50) NOT NULL,
  severity      VARCHAR(10) NOT NULL CHECK (severity IN ('high','med','low')),
  title         TEXT NOT NULL,
  description   TEXT,
  territory_ids INTEGER[],
  affected_hcps INTEGER DEFAULT 0,
  request_id    INTEGER REFERENCES requests(id),
  is_dismissed  BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMP DEFAULT NOW(),
  resolved_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_zips_code          ON zips(code);
CREATE INDEX IF NOT EXISTS idx_zips_territory     ON zips(territory_id);
CREATE INDEX IF NOT EXISTS idx_hcps_territory     ON hcps(territory_id);
CREATE INDEX IF NOT EXISTS idx_hcps_zip           ON hcps(zip);
CREATE INDEX IF NOT EXISTS idx_hcps_tier          ON hcps(tier);
CREATE INDEX IF NOT EXISTS idx_requests_status    ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON requests(requester_id);
CREATE INDEX IF NOT EXISTS idx_audit_created      ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user         ON audit_log(user_id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $func$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$func$ LANGUAGE plpgsql;

CREATE TRIGGER trg_territories_updated
  BEFORE UPDATE ON territories
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_hcps_updated
  BEFORE UPDATE ON hcps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
