// src/checkout.js — builds the order summary shown on the checkout page

const { calculateTotal } = require('./cart');
const { formatPrice, itemCountLabel } = require('./format');

function orderSummary(items, couponPercent) {
  const total = calculateTotal(items, couponPercent);
  return {
    label: itemCountLabel(items.length),
    total,
    display: formatPrice(total),
  };
}

module.exports = { orderSummary };
