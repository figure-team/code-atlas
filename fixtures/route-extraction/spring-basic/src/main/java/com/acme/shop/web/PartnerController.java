package com.acme.shop.web;

import com.acme.shop.annot.ApiMapping;
import com.acme.shop.annot.WebController;

@WebController
public class PartnerController {

    @ApiMapping("/partners/pay")
    public String pay() {
        return "ok";
    }

    @ApiMapping(ExternalConstants.CALLBACK)
    public String callback() {
        return "ok";
    }
}
