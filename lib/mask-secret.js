function maskSecret(value) {
  if (value === undefined || value === null || value === '') return null;

  const text = String(value);

  if (text.length <= 8) {
    return '*'.repeat(text.length);
  }

  return `${text.slice(0, 4)}${'*'.repeat(Math.min(12, text.length - 8))}${text.slice(-4)}`;
}

module.exports = { maskSecret };
