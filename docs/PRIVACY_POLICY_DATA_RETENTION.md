# Privacy Policy - Data Retention and Right to be Forgotten

## Overview

This document outlines AgreeStellar's data retention policies and procedures for handling user data deletion requests in compliance with GDPR (General Data Protection Regulation), CCPA (California Consumer Privacy Act), and other global privacy regulations.

## Data Retention Timeline

### Active User Data

**Retention Period:** Indefinite while account remains active

**Data Categories Retained:**
- Wallet address (public key)
- Subscription records
- Payment/billing events
- User preferences
- Activity logs
- Comments and engagement data

**Purpose:** Service delivery, payment processing, content delivery, analytics

### Inactive User Data

**Retention Period:** 3 years from last activity

**Definition of Inactivity:** No subscription activity, no logins, no content interactions for 3 consecutive years

**Automated Action:** PII is automatically scrubbed after 3 years of inactivity

### Financial Data

**Retention Period:** 7 years (tax compliance requirement)

**Data Categories Retained:**
- Billing events
- Transaction records
- Payment amounts
- Subscription duration

**Anonymization:** User identity is cryptographically hashed, but financial data is preserved for tax accounting

**Purpose:** Tax compliance, financial auditing, fraud prevention

### Audit Logs

**Retention Period:** 5 years

**Data Categories Retained:**
- System access logs
- API request logs
- Security events
- Compliance actions

**Purpose:** Security monitoring, compliance auditing, incident response

## Right to be Forgotten (Data Deletion)

### User-Initiated Deletion

**Eligibility:** Any user may request deletion of their personal data at any time

**Process:**
1. User submits deletion request via API endpoint or support ticket
2. System verifies user identity (wallet signature or authentication)
3. PII scrubbing process is initiated within 24 hours
4. User receives confirmation of completion
5. Affected merchants receive webhook notification

**Data Deleted:**
- Email addresses
- IP addresses
- User names
- Profile information
- Device fingerprints
- Any other directly identifying information

**Data Preserved (Anonymized):**
- Financial records (with anonymized user identity)
- Audit logs (with anonymized user identity)
- System records required for compliance

### Automated Retention Policy

**Trigger:** 3 years of account inactivity

**Process:**
1. Automated job runs weekly to identify inactive users
2. PII scrubbing is performed automatically
3. Audit log entry is created
4. No notification is sent (user is inactive)

**Scope:** All PII across database, Redis cache, and analytics warehouse

## Data Categories and Retention

### Personal Identifiable Information (PII)

| Data Category | Active Retention | Inactive Retention | Deletion Method |
|---------------|------------------|-------------------|-----------------|
| Email Address | Until account deletion | 3 years | Cryptographic hash |
| IP Address | 1 year | 3 years | Cryptographic hash |
| Device Fingerprint | 1 year | 3 years | Deletion |
| User Name | Until account deletion | 3 years | Deletion |
| Profile Bio | Until account deletion | 3 years | Deletion |
| Avatar Image | Until account deletion | 3 years | Deletion |

### Financial Data

| Data Category | Retention Period | Deletion Method |
|---------------|------------------|-----------------|
| Billing Events | 7 years | Anonymized (wallet hashed) |
| Transaction Records | 7 years | Anonymized (wallet hashed) |
| Subscription Records | 7 years | Anonymized (wallet hashed) |
| Payment Amounts | 7 years | Preserved (tax compliance) |

### Content Data

| Data Category | Retention Period | Deletion Method |
|---------------|------------------|-----------------|
| User Comments | Until account deletion | 3 years (anonymized) |
| User Likes | Until account deletion | 3 years (anonymized) |
| User Content | Until account deletion | 3 years (anonymized) |

### System Data

| Data Category | Retention Period | Deletion Method |
|---------------|------------------|-----------------|
| Audit Logs | 5 years | Preserved (compliance) |
| API Logs | 1 year | Deletion |
| Error Logs | 1 year | Deletion |
| Performance Metrics | 1 year | Deletion |

## Data Deletion Process

### Technical Implementation

**Cryptographic Hashing:**
- Algorithm: SHA-256 with HMAC
- Salt: Environment-specific secure salt (32 bytes)
- Format: `prefix_hash` for debugging, irreversible for security

**Wallet Address Anonymization:**
- Original: `GD5DQ6ZQZKQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQZQ`
- Anonymized: `GD5DQ6ZQZ_abc123def456...` (first 8 chars + hash)

**Email Anonymization:**
- Original: `user@example.com`
- Anonymized: `scrubbed_[hash]@anon.example.com`

**IP Address Anonymization:**
- Original: `192.168.1.100`
- Anonymized: `scrubbed_[hash]`

### Database Tables Scrubbed

1. **subscriptions** - user_email, wallet_address
2. **creator_audit_logs** - ip_address
3. **api_key_audit_logs** - ip_address
4. **data_export_tracking** - requester_email
5. **privacy_preferences** - share_email_with_merchants
6. **comments** - user_address
7. **leaderboard_entries** - fan_address
8. **social_tokens** - user_address
9. **activitypub_engagements** - fan_address

### Cache Scrubbing

**Redis Keys Scrubbed:**
- `user:{walletAddress}:*`
- `profile:{walletAddress}:*`
- `subscription:{walletAddress}:*`
- `creator:{walletAddress}:*`
- `session:{walletAddress}:*`
- `cache:{walletAddress}:*`

### Analytics Warehouse

**Data Anonymized:**
- User identifiers replaced with hashed values
- IP addresses removed or hashed
- Email addresses removed or hashed
- Device fingerprints removed

## Merchant Notifications

### Webhook Payload

When a user invokes their right to be forgotten, affected merchants receive a webhook notification:

```json
{
  "event": "user.forget",
  "timestamp": "2026-04-26T14:00:00Z",
  "scrub_id": "uuid-v4",
  "data": {
    "anonymized_wallet_address": "GD5DQ6ZQZ_abc123...",
    "reason": "user_request",
    "scrubbed_at": "2026-04-26T14:00:00Z"
  }
}
```

**Purpose:** Inform merchants that user data has been deleted so they can update their own records

**Timing:** Within 24 hours of deletion request

**Security:** Webhooks signed with merchant's secret

## Audit Trail

All deletion operations are logged with:

- Scrub operation ID (UUID)
- Original wallet address (hashed)
- Anonymized wallet address
- Reason for deletion
- Timestamp
- Tables affected
- Rows modified
- Operator (user/admin/system)
- Success/failure status

**Retention:** Audit logs retained for 5 years for compliance

## Verification

Users can verify their data has been deleted by:

1. Calling the verification endpoint with their wallet address
2. Receiving confirmation of scrubbing status
3. Reviewing which tables were affected

**Endpoint:** `GET /api/v1/compliance/forget/:walletAddress/status`

## Data Export (Right to Data Portability)

Users may request a copy of their data before deletion:

**Endpoint:** `POST /api/v1/compliance/export`

**Data Included:**
- Subscriptions
- Comments
- Audit logs (last 100 entries)
- Privacy preferences

**Format:** JSON

**Delivery:** Secure download link (expires in 7 days)

## Exceptions and Limitations

### Data That Cannot Be Deleted

1. **Financial Records** - Required for tax compliance (7 years)
2. **Audit Logs** - Required for security and compliance (5 years)
3. **Blockchain Transactions** - Immutable public ledger
4. **Legal Holds** - Data subject to legal preservation orders

### Data That Is Anonymized Not Deleted

1. **Subscription Records** - Financial data preserved, identity hashed
2. **Billing Events** - Payment data preserved, identity hashed
3. **Content Engagement** - Content preserved, user identity hashed

## Compliance Certifications

This data retention policy is designed to comply with:

- **GDPR** (EU General Data Protection Regulation)
  - Article 17: Right to erasure ("right to be forgotten")
  - Article 20: Right to data portability
  - Recital 39: Data minimization

- **CCPA** (California Consumer Privacy Act)
  - Right to delete
  - Right to know
  - Right to opt-out

- **LGPD** (Brazilian General Data Protection Law)
  - Right to deletion
  - Right to data portability

- **POPIA** (South African Protection of Personal Information Act)
  - Right to deletion
  - Data minimization

## Contact

For data deletion requests or privacy-related inquiries:

- **Email:** privacy@substream.protocol
- **API:** POST /api/v1/compliance/forget
- **Support:** https://support.substream.protocol

## Last Updated

April 26, 2026

## Version History

- **v1.0** (April 26, 2026) - Initial policy for automated PII scrubbing
