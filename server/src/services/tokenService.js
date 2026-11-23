const jwt = require('jsonwebtoken');

const MIN_SECRET_LENGTH = 32;
const INSECURE_SECRET_PATTERNS = [
  /change[-_ ]?me/i,
  /super[-_ ]?secret/i,
  /example/i,
  /replace/i,
  /placeholder/i,
];

function readSecret(name) {
  const value = process.env[name];
  if (!value || value.trim().length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${name} must be set to a random value of at least ${MIN_SECRET_LENGTH} characters. ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  if (INSECURE_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${name} still contains a placeholder or known-insecure value. Rotate it before starting the server.`);
  }
  return value;
}

function validateTokenSecrets() {
  const access = readSecret('JWT_ACCESS_SECRET');
  const refresh = readSecret('JWT_REFRESH_SECRET');
  if (access === refresh) {
    throw new Error('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be different values.');
  }
}

function signAccessToken(payload) {
  return jwt.sign(payload, readSecret('JWT_ACCESS_SECRET'), {
    expiresIn: process.env.JWT_ACCESS_TTL || '15m',
  });
}

function signRefreshToken(payload) {
  return jwt.sign(payload, readSecret('JWT_REFRESH_SECRET'), {
    expiresIn: process.env.JWT_REFRESH_TTL || '30d',
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, readSecret('JWT_ACCESS_SECRET'));
}

function verifyRefreshToken(token) {
  return jwt.verify(token, readSecret('JWT_REFRESH_SECRET'));
}

module.exports = {
  validateTokenSecrets,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
};
