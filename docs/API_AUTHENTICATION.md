# API Authentication Documentation

## Overview

The Substream-cor uses wallet-based authentication following the SIWE (Sign In With Ethereum) pattern. Users authenticate by signing a message with their wallet, which is then verified on the backend to issue a JWT token.

## Authentication Flow

### 1. POST /auth/login

Authenticate with the backend using a wallet signature.

#### Request Body
```json
{
  "address": "0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45",
  "signature": "0x4355c47d63924e8a72e509b65029052eb6c50d03db4e6b1b3b9f1c2d3a4e5f6b",
  "message": "Sign in to AgreeStellar at 2024-03-23T16:14:00.000Z",
  "nonce": "random_nonce_string"
}
```

#### Response
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "address": "0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45",
    "tier": "bronze"
  },
  "expiresIn": 86400
}
```

#### Error Response
```json
{
  "success": false,
  "error": "Invalid signature"
}
```

### 2. JWT Token Usage

Once authenticated, include the JWT token in the Authorization header for all protected endpoints:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

#### Token Structure
The JWT token contains the following claims:
- `address`: User's wallet address
- `tier`: User's subscription tier (bronze, silver, gold)
- `iat`: Issued at timestamp
- `exp`: Expiration timestamp (24 hours)

#### Protected Endpoints
All endpoints except `/` and `/auth/login` require a valid JWT token.

## Implementation Details

### SIWE Message Format
The message to sign should follow this format:
```
Sign in to AgreeStellar at {timestamp}

Nonce: {nonce}
Address: {wallet_address}
```

### Signature Verification
The backend verifies:
1. The signature matches the address
2. The nonce is valid and hasn't been used
3. The timestamp is within acceptable range (5 minutes)

### Security Considerations
- Nonces are single-use and expire after 5 minutes
- JWT tokens expire after 24 hours
- Rate limiting is applied to login attempts
- All sensitive operations require valid JWT authentication

## Example Usage

### JavaScript/Node.js
```javascript
const response = await fetch('/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    address: '0x742d35Cc6634C0532925a3b8D4C9db96C4b4Db45',
    signature: '0x4355c47d63924e8a72e509b65029052eb6c50d03db4e6b1b3b9f1c2d3a4e5f6b',
    message: 'Sign in to AgreeStellar at 2024-03-23T16:14:00.000Z',
    nonce: 'random_nonce_string'
  })
});

const { token } = await response.json();

// Use token for authenticated requests
const protectedResponse = await fetch('/content', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

## Troubleshooting

### Common Errors

1. **Invalid signature**: Check that the signature was created with the correct message and address
2. **Expired nonce**: Request a new nonce and try again
3. **Token expired**: Re-authenticate to get a new token
4. **Invalid token format**: Ensure the token is included in the Authorization header with "Bearer " prefix

### Support
For authentication issues, check the browser console for detailed error messages or contact support with your wallet address.
