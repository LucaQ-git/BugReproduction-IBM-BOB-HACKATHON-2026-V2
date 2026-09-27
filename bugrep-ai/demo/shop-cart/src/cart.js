// src/cart.js — checkout pricing for the shop

/**
 * Calculate the total for a cart after a percentage discount.
 * @param {Array<{price:number}>} items
 * @param {number} discountPercentage
 */
function calculateTotal(items, discountPercentage) {
  let subtotal = items.reduce((sum, item) => sum + item.price, 0);
  let discount = (subtotal * discountPercentage) / 100;
  return subtotal - discount;
}

module.exports = { calculateTotal };
