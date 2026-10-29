from shop.cart import cart_total


def test_cart_total():
    assert cart_total([1, 2]) == 3
