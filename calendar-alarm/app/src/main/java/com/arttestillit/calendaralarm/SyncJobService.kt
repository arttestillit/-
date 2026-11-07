package com.arttestillit.calendaralarm

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.provider.CalendarContract

object SyncJobs {
    private const val JOB_CALENDAR_CHANGED = 1
    private const val JOB_PERIODIC = 2

    fun schedule(context: Context) {
        val js = context.getSystemService(JobScheduler::class.java)
        val component = ComponentName(context, SyncJobService::class.java)

        // カレンダーが変更されたら（予定の追加・移動・削除）数秒後に同期する。
        // コンテンツ監視ジョブは1回きりなので、実行のたびに登録し直す。
        js.schedule(
            JobInfo.Builder(JOB_CALENDAR_CHANGED, component)
                .addTriggerContentUri(
                    JobInfo.TriggerContentUri(
                        CalendarContract.CONTENT_URI,
                        JobInfo.TriggerContentUri.FLAG_NOTIFY_FOR_DESCENDANTS,
                    ),
                )
                .setTriggerContentUpdateDelay(3_000)
                .setTriggerContentMaxDelay(60_000)
                .build(),
        )

        // 48時間先までの先読みを進めるため、定期的にも同期する。
        if (js.getPendingJob(JOB_PERIODIC) == null) {
            js.schedule(
                JobInfo.Builder(JOB_PERIODIC, component)
                    .setPeriodic(60 * 60 * 1000L)
                    .setPersisted(true)
                    .build(),
            )
        }
    }

    fun isCalendarJob(params: JobParameters) = params.jobId == JOB_CALENDAR_CHANGED
}

class SyncJobService : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        Thread {
            try {
                AlarmScheduler.sync(applicationContext)
            } finally {
                if (SyncJobs.isCalendarJob(params)) SyncJobs.schedule(applicationContext)
                jobFinished(params, false)
            }
        }.start()
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true
}
