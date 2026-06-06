# Branch Protection Rules Configuration

**Repository:** AgreeStellar-Network/Substream-cor  
**Document Version:** 1.0  
**Last Updated:** 2026-04-26

---

## Required Branch Protection Rules

### Main Branch Protection

The `main` branch must have the following protection rules enforced:

#### Pull Request Reviews

- **Required Approving Review Count:** 2
- **Dismiss Stale Reviews:** Enabled
- **Require Code Owner Reviews:** Enabled
- **Require Last Push Approval:** Enabled
- **Require Resolution of Review Requests Before Merging:** Enabled

#### Status Checks

- **Required Status Checks:** Strict mode enabled
- **Required Contexts:**
  - CI/CD Pipeline
  - Security Scan
  - Unit Tests
  - Integration Tests
  - RLS Security Tests

#### Branch Restrictions

- **Enforce Admins:** Enabled (admins must also follow rules)
- **Allow Deletions:** Disabled
- **Allow Force Pushes:** Disabled
- **Restrict Pushes:** Restricted to core-team

---

## Configuration Commands

### Using GitHub CLI

**Install GitHub CLI:**
```bash
# macOS
brew install gh

# Windows
winget install --id GitHub.cli

# Linux
sudo apt install gh
```

**Authenticate:**
```bash
gh auth login
```

**Set Branch Protection:**
```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection \
  --method PUT \
  -f required_pull_request_reviews[required_approving_review_count]=2 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true \
  -f required_pull_request_reviews[require_code_owner_reviews]=true \
  -f required_pull_request_reviews[require_last_push_approval]=true \
  -f required_status_checks[strict]=true \
  -f enforce_admins=true \
  -f allow_deletions=false \
  -f allow_force_pushes=false
```

**Add Required Status Checks:**
```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection/required_status_checks \
  --method PUT \
  -f strict=true \
  -f checks[]="CI/CD Pipeline" \
  -f checks[]="Security Scan" \
  -f checks[]="Unit Tests" \
  -f checks[]="Integration Tests" \
  -f checks[]="RLS Security Tests"
```

**Restrict Push Access:**
```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection/restrictions \
  --method PUT \
  -f apps[]=github-actions \
  -f teams[]=core-team
```

### Using GitHub API (curl)

**Set Branch Protection:**
```bash
curl -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/AgreeStellar-Network/Substream-cor/branches/main/protection \
  -d '{
    "required_pull_request_reviews": {
      "required_approving_review_count": 2,
      "dismiss_stale_reviews": true,
      "require_code_owner_reviews": true,
      "require_last_push_approval": true
    },
    "required_status_checks": {
      "strict": true,
      "contexts": [
        "CI/CD Pipeline",
        "Security Scan",
        "Unit Tests",
        "Integration Tests",
        "RLS Security Tests"
      ]
    },
    "enforce_admins": true,
    "allow_deletions": false,
    "allow_force_pushes": false
  }'
```

**Restrict Push Access:**
```bash
curl -X PUT \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/AgreeStellar-Network/Substream-cor/branches/main/protection/restrictions \
  -d '{
    "apps": ["github-actions"],
    "teams": ["core-team"]
  }'
```

---

## Verification Commands

### Check Current Branch Protection

**Using GitHub CLI:**
```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection
```

**Expected Output:**
```json
{
  "url": "https://api.github.com/repos/AgreeStellar-Network/Substream-cor/branches/main/protection",
  "required_pull_request_reviews": {
    "required_approving_review_count": 2,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": true,
    "require_last_push_approval": true
  },
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "CI/CD Pipeline",
      "Security Scan",
      "Unit Tests",
      "Integration Tests",
      "RLS Security Tests"
    ]
  },
  "enforce_admins": true,
  "allow_deletions": false,
  "allow_force_pushes": false
}
```

**Using curl:**
```bash
curl -H "Authorization: token $GITHUB_TOKEN" \
  https://api.github.com/repos/AgreeStellar-Network/Substream-cor/branches/main/protection
```

### Check Status Checks

```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection/required_status_checks
```

### Check Push Restrictions

```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection/restrictions
```

---

## Pre-Merge Checklist

Before any code is merged to `main`, ensure:

1. **Code Review:**
   - [ ] At least 2 approvals from core team members
   - [ ] All review comments addressed
   - [ ] No outstanding requested changes

2. **CI/CD Pipeline:**
   - [ ] Build verification passed
   - [ ] Linting passed (ESLint)
   - [ ] Type checking passed (TypeScript)

3. **Security:**
   - [ ] No critical vulnerabilities detected
   - [ ] No high vulnerabilities detected
   - [ ] Dependency scan passed
   - [ ] Secret scan passed

4. **Testing:**
   - [ ] Unit tests passed
   - [ ] Integration tests passed
   - [ ] RLS security tests passed
   - [ ] Soroban contract tests passed

5. **Documentation:**
   - [ ] README updated if required
   - [ ] API documentation updated if required
   - [ ] Changelog updated

6. **Database:**
   - [ ] Migrations tested in staging
   - [ ] Rollback plan documented
   - [ ] Data migration validated

7. **Performance:**
   - [ ] No performance regression
   - [ ] Load tests passed if applicable

---

## GitHub Actions Workflow

### Required Status Checks

The following GitHub Actions workflows must be configured:

#### 1. CI/CD Pipeline (`.github/workflows/ci.yml`)

```yaml
name: CI/CD Pipeline

on:
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm run build
      - run: npm test
```

#### 2. Security Scan (`.github/workflows/security.yml`)

```yaml
name: Security Scan

on:
  pull_request:
    branches: [main]

jobs:
  security:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm audit
      - uses: snyk/actions/node@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
```

#### 3. Unit Tests (`.github/workflows/unit-tests.yml`)

```yaml
name: Unit Tests

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test -- --testPathPattern="unit"
```

#### 4. Integration Tests (`.github/workflows/integration-tests.yml`)

```yaml
name: Integration Tests

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test -- --testPathPattern="integration"
```

#### 5. RLS Security Tests (`.github/workflows/rls-security.yml`)

```yaml
name: RLS Security Tests

on:
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:14
        env:
          POSTGRES_PASSWORD: postgres
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test -- tests/rlsSecurity.test.js
```

---

## Code Owners Configuration

Create `.github/CODEOWNERS` file to enforce code owner reviews:

```
# Global code owners
* @dijangh904

# Security files
SECURITY_ARCHITECTURE.md @security-team
*.md @dijangh904

# Database migrations
migrations/ @database-team

# Security-critical files
middleware/ @security-team
src/services/rlsService.js @security-team
src/interceptors/tenant-data-leakage.interceptor.ts @security-team

# Soroban contracts
src/services/soroban* @blockchain-team
routes/vault.js @blockchain-team

# API routes
routes/ @api-team

# Tests
tests/ @qa-team
*.test.js @qa-team
```

---

## Automated Enforcement

### Pre-Commit Hook

Create `.husky/pre-commit`:

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run linter
npm run lint

# Run security sweep
node scripts/security-sweep-console-logs.js

# Run unit tests
npm test -- --testPathPattern="unit"
```

### Pre-Push Hook

Create `.husky/pre-push`:

```bash
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"

# Run full test suite
npm test

# Run security scan
npm audit
```

---

## Monitoring and Alerts

### Branch Protection Violations

Set up alerts for:
- Failed status checks
- Bypass attempts
- Force push attempts
- Deletion attempts

**Alert Configuration:**
```bash
# Create GitHub webhook for branch protection events
gh api repos/AgreeStellar-Network/Substream-cor/hooks \
  -f name="webhook" \
  -f active=true \
  -f events='["branch_protection_rule","pull_request"]' \
  -f config[url]="https://alerts.substream.io/webhook"
```

---

## Rollback Procedure

If a bad merge occurs:

1. **Identify the bad commit:**
```bash
git log --oneline -10
```

2. **Revert the merge:**
```bash
git revert -m 1 <merge-commit-hash>
```

3. **Push the revert:**
```bash
git push origin main
```

4. **Investigate the issue**
5. **Fix the underlying problem**
6. **Create a new PR with the fix**

---

## Compliance

### SOC 2 Requirements

- **Access Control:** Branch protection enforces separation of duties
- **Change Management:** All changes require review and testing
- **Audit Trail:** All merges are logged with author and reviewer information
- **Monitoring:** Status checks ensure quality gates

### ISO 27001 Requirements

- **Access Control:** Role-based permissions enforced
- **Change Management:** Formal approval process
- **Information Security:** Security scans required
- **Operations Management:** Automated testing and validation

---

## Troubleshooting

### Status Checks Failing

**Check logs:**
```bash
gh run view
```

**Re-run failed checks:**
```bash
gh run rerun <run-id>
```

### Approval Issues

**Check required reviewers:**
```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection
```

**Add code owners:**
Edit `.github/CODEOWNERS` file

### Bypass Protection (Emergency Only)

**Emergency bypass requires:**
1. Security Council approval
2. Documented reason
3. Post-incident review

**Bypass command:**
```bash
gh api repos/AgreeStellar-Network/Substream-cor/branches/main/protection \
  --method DELETE
```

**Restore protection after emergency:**
```bash
# Re-run configuration commands
```

---

## References

- [GitHub Branch Protection API](https://docs.github.com/en/rest/repos/branches)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [CODEOWNERS Documentation](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)
- [SECURITY_ARCHITECTURE.md](../SECURITY_ARCHITECTURE.md)

---

**Document Classification:** Internal  
**Next Review:** 2026-10-26 (6 months)
