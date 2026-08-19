<script setup lang="ts">
import { useAppStore } from "~/stores/appStore";

const appStore = useAppStore();
const { can, load } = usePermissions();
await load();
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div class="grid gap-8 lg:grid-cols-3">
      <!-- Main column -->
      <div class="lg:col-span-2">
        <DashboardFrontDeskToday />
        <DashboardKpiCards class="mt-6" />
      </div>

      <!-- Right column: week calendar -->
      <div>
        <DashboardWeekCalendar />
      </div>
    </div>
  </div>
</template>
