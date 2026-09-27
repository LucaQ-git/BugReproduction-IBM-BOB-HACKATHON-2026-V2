// src/format.js — display helpers

function formatPrice(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function itemCountLabel(count) {
  return count === 1 ? '1 item' : `${count} items`;
}

module.exports = { formatPrice, itemCountLabel };
