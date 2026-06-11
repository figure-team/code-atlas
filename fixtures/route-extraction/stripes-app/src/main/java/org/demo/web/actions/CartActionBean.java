package org.demo.web.actions;

import net.sourceforge.stripes.action.UrlBinding;

@UrlBinding("/shop/cart.action")
public class CartActionBean extends AbstractActionBean {

    public String view() {
        return "cart";
    }
}
