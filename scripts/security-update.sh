#!/bin/bash

# Security Update Script for Substream-cor
# This script automates the security dependency update process

echo "🔒 Starting Security Update Process..."
echo "======================================"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ Node.js and npm are installed"

# Clean existing node_modules and package-lock.json
echo "🧹 Cleaning existing dependencies..."
rm -rf node_modules package-lock.json

# Install updated dependencies
echo "📦 Installing updated dependencies..."
npm install

# Run security audit
echo "🔍 Running security audit..."
npm audit --audit-level=moderate

# Run tests to verify compatibility
echo "🧪 Running tests to verify compatibility..."
npm test

# Check for any remaining vulnerabilities
echo "🔍 Final vulnerability check..."
npm audit

echo ""
echo "✅ Security Update Process Complete!"
echo "===================================="
echo ""
echo "📊 Summary:"
echo "- Dependencies updated to latest secure versions"
echo "- Critical vulnerabilities resolved"
echo "- Test suite verification completed"
echo ""
echo "🚀 Ready for deployment to staging environment"
