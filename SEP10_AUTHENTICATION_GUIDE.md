# SEP-10 Stellar Authentication Implementation Guide

## Overview

This implementation provides complete SEP-10 (Stellar Web Authentication) support for the Substream-cor, allowing users to authenticate securely using Stellar wallets without usernames, passwords, or emails.

## Architecture

### Core Components

1. **StellarAuthService** (`services/stellarAuthService.js`)
   - Handles SEP-10 challenge generation and verification
   - Manages cryptographic operations with Stellar SDK
   - Ensures compliance with SEP-10 specification

2. **Stellar Authentication Middleware** (`middleware/stellarAuth.js`)
   - JWT token generation and validation for Stellar users
   - Session management with unique session IDs
   - Cookie-based authentication support

3. **Unified Authentication Middleware** (`middleware/unifiedAuth.js`)
   - Supports both Ethereum and Stellar authentication
   - Automatic token type detection and routing
   - Backward compatibility with existing Ethereum auth

4. **Authentication Routes** (`routes/stellarAuth.js`)
   - `/auth/challenge` - Generate SEP-10 challenge
   - `/auth/verify` - Verify signed challenge and issue JWT
   - Additional session management endpoints

## API Endpoints

### Primary Authentication Flow

#### 1. Generate Challenge
```
GET /auth/challenge?publicKey=<STELLAR_PUBLIC_KEY>
```

**Response:**
```json
{
  "success": true,
  "challenge": "XDR_ENCODED_CHALLENGE_TRANSACTION",
  "nonce": "BASE64_ENCODED_NONCE",
  "expiresAt": "2024-01-01T12:05:00.000Z"
}
```

#### 2. Verify Challenge and Authenticate
```
POST /auth/verify
Content-Type: application/json

{
  "publicKey": "<STELLAR_PUBLIC_KEY>",
  "challengeXDR": "<SIGNED_CHALLENGE_XDR>"
}
```

**Response:**
```json
{
  "success": true,
  "token": "<JWT_TOKEN>",
  "user": {
    "publicKey": "<normalized_public_key>",
    "tier": "bronze",
    "type": "stellar"
  },
  "expiresIn": 86400
}
```

### Session Management

#### Get Session Info
```
GET /auth/stellar/session
Authorization: Bearer <JWT_TOKEN>
```

#### Logout
```
POST /auth/stellar/logout
Authorization: Bearer <JWT_TOKEN>
```

#### Switch Wallet
```
POST /auth/stellar/switch
Authorization: Bearer <CURRENT_JWT_TOKEN>
Content-Type: application/json

{
  "newPublicKey": "<NEW_STELLAR_PUBLIC_KEY>",
  "challengeXDR": "<SIGNED_CHALLENGE_XDR>"
}
```

## SEP-10 Compliance

### Challenge Transaction Requirements

The implementation follows SEP-10 specification exactly:

1. **Transaction Structure**: Single manageData operation
2. **Operation Name**: `<domain> auth` format
3. **Source Account**: Client's Stellar public key
4. **Nonce**: Cryptographically secure random value
5. **Timebounds**: 5-minute validity window
6. **Network**: Configurable (testnet/mainnet)

### Security Features

- **Cryptographic Verification**: Validates wallet signature against original challenge
- **Nonce Reuse Prevention**: Each challenge can only be used once
- **Time-based Expiration**: Challenges expire after 5 minutes
- **Account Status Verification**: Checks for active, non-merged accounts
- **Session Management**: Unique session IDs with activity tracking

## JWT Token Structure

### Token Claims
```json
{
  "publicKey": "<normalized_stellar_public_key>",
  "tier": "bronze|silver|gold",
  "type": "stellar",
  "iat": 1234567890,
  "sessionId": "<unique_session_id>"
}
```

### Security Features
- **Short-lived**: 24-hour expiration
- **Session Binding**: Tied to specific session ID
- **Type Identification**: Clear token type for middleware routing
- **Revocation Support**: Sessions can be invalidated

## Integration Examples

### Frontend Integration (JavaScript)

```javascript
// 1. Generate challenge
const response = await fetch('/auth/challenge?publicKey=GABC...');
const { challenge } = await response.json();

// 2. Sign challenge with wallet (e.g., Freighter)
const signedChallenge = await freighter.signTransaction(challenge);

// 3. Verify and get token
const authResponse = await fetch('/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    publicKey: 'GABC...',
    challengeXDR: signedChallenge
  })
});

const { token } = await authResponse.json();
localStorage.setItem('authToken', token);
```

### Protected API Access

```javascript
// Access protected endpoint
const response = await fetch('/content/my-videos', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

## Configuration

### Environment Variables

```bash
# Stellar Network Configuration
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
STELLAR_HORIZON_URL="https://horizon-testnet.stellar.org"

# Authentication
JWT_SECRET="your-secure-secret-key"
DOMAIN="substream.app"

# Test Credentials (for integration testing)
STELLAR_TEST_PUBLIC_KEY="GABC..."
STELLAR_TEST_SECRET="SABC..."
```

## Testing

### Unit Tests
- Challenge generation and validation
- JWT token creation and verification
- Middleware authentication logic
- SEP-10 specification compliance

### Integration Tests
- Full authentication flow with testnet accounts
- Protected endpoint access
- Session management
- Wallet switching functionality

### Running Tests
```bash
# Run all authentication tests
npm test -- stellarAuth.test.js

# Run SEP-10 compliance tests
npm test -- sep10Compliance.test.js

# Run integration tests (requires testnet credentials)
STELLAR_TEST_PUBLIC_KEY=GABC... STELLAR_TEST_SECRET=SABC... npm test
```

## Security Considerations

### Production Deployment

1. **HTTPS Required**: All authentication endpoints must use HTTPS
2. **Secure JWT Secret**: Use strong, randomly generated secrets
3. **Rate Limiting**: Implement rate limiting on auth endpoints
4. **CORS Configuration**: Properly configure cross-origin requests
5. **Session Storage**: Use Redis for production session management

### Best Practices

1. **Token Refresh**: Implement token refresh mechanism
2. **Session Cleanup**: Regular cleanup of expired sessions
3. **Audit Logging**: Log authentication events for security
4. **Error Handling**: Generic error messages to prevent information leakage
5. **Input Validation**: Strict validation of all inputs

## Migration Guide

### From Ethereum Authentication

1. **Update Frontend**: Replace SIWE flow with SEP-10 flow
2. **Update API Calls**: Use new `/auth/challenge` and `/auth/verify` endpoints
3. **Token Handling**: Existing middleware supports both token types
4. **User Identification**: Use `getUserId()` helper for unified access

### Backward Compatibility

- Existing Ethereum tokens continue to work
- Unified middleware automatically detects token type
- No breaking changes to existing protected routes
- Gradual migration possible

## Troubleshooting

### Common Issues

1. **Invalid Challenge XDR**
   - Check network passphrase configuration
   - Verify challenge hasn't expired
   - Ensure proper XDR encoding

2. **Signature Verification Failed**
   - Verify wallet signed the correct transaction
   - Check public key format and validity
   - Ensure transaction wasn't modified

3. **JWT Token Issues**
   - Verify JWT secret consistency
   - Check token expiration
   - Validate session ID exists

4. **Account Status Errors**
   - Ensure account exists on network
   - Check account isn't merged
   - Verify network connectivity

### Debug Mode

Enable debug logging:
```bash
DEBUG=stellar:* npm run dev
```

## Support

For issues related to:
- **SEP-10 Specification**: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md
- **Stellar SDK**: https://github.com/stellar/js-stellar-sdk
- **Implementation Issues**: Create GitHub issue with detailed logs

## Future Enhancements

1. **Multi-sig Support**: Support for multi-signature accounts
2. **Hardware Wallets**: Enhanced support for Ledger/Trezor
3. **Delegation Support**: Stellar account delegation features
4. **Biometric Auth**: Integration with mobile biometric authentication
5. **Social Recovery**: Account recovery mechanisms
