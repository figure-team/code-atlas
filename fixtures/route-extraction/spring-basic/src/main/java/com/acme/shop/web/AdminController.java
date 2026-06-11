package com.acme.shop.web;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;

@Controller
@RequestMapping("/admin/*")
public class AdminController {

    @PostMapping("save")
    public String save() {
        return "admin/save";
    }
}
