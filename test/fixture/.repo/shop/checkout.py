from shop.cart import cart_total


def checkout(prices):
    return round(cart_total(prices) * 1.2, 2)
