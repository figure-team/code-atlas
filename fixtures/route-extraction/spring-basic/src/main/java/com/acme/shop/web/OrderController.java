package com.acme.shop.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.ResponseBody;

@Controller
@RequestMapping("/orders")
public class OrderController {

    @GetMapping("/list")
    public String list() {
        return "order/list";
    }

    @GetMapping({ "/detail", "/show" })
    public String detail() {
        return "order/detail";
    }

    @RequestMapping(value = "/save", method = RequestMethod.POST)
    public String save() {
        return "redirect:/orders/list";
    }

    @RequestMapping(value = "/sync", method = { RequestMethod.GET, RequestMethod.POST })
    @ResponseBody
    public String sync() {
        return "ok";
    }

    @GetMapping("/export")
    public ResponseEntity<byte[]> export() {
        return null;
    }

    @GetMapping({ "/history", "/history/" })
    public String history() {
        return "order/history";
    }
}
