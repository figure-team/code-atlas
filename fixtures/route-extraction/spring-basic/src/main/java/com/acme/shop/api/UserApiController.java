package com.acme.shop.api;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(ApiConstants.BASE)
public class UserApiController {

    private static final String DETAIL = "/users/{id}";

    @GetMapping("/users")
    public String listUsers() {
        return "users";
    }

    @GetMapping(DETAIL)
    public String getUser() {
        return "user";
    }

    @GetMapping(value = "/users/export", produces = "application/json")
    public String exportUsers() {
        return "export";
    }

    @GetMapping("/users/active" /* active accounts only */)
    public String activeUsers() {
        return "active";
    }

    private static final String REPORT_BASE = "/users/report";

    @GetMapping(REPORT_BASE + "/pdf")
    public String reportPdf() {
        return "pdf";
    }
}
