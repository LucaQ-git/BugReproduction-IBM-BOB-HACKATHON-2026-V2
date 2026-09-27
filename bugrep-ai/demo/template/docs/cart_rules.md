# Shopping Cart Business Rules

## Core rules (original)

1. Subtotals are calculated from item prices.
2. Cart totals must NEVER drop below 0, even with discounts applied.
3. An empty cart (0 items) must always return a total of 0.

## Input validation rules (agreed 2025)

4. **Missing or undefined `discountPercentage`** — treat as 0% (full price returned).
5. **Negative `discountPercentage`** — clamp to 0%; a discount cannot act as a surcharge.
6. **`NaN` or `±Infinity` discount** — throw `RangeError`; these are programming errors.
7. **Item with missing, undefined, or non-numeric price** — throw `TypeError`.
8. **Item with negative price** — throw `TypeError`; prices must be non-negative.

## Precision rule

9. **All returned totals are rounded to 2 decimal places** (standard currency precision).
