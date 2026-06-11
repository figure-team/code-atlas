package com.acme.batch;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class ReportJob {

    @Scheduled(cron = "0 0 4 * * ?")
    public void nightly() {
    }

    @Scheduled(cron = "0 0 6 * * MON")
    @Scheduled(cron = "0 0 18 * * FRI")
    public void weekly() {
    }
}
