<script setup lang="ts">
import { useAppStore } from "~/stores/appStore";

const appStore = useAppStore();
const { can, load } = usePermissions();
await load();
</script>

<template>
  <div class="mx-auto max-w-6xl p-6 md:p-10">
    <div class="grid gap-8 lg:grid-cols-3">
      <!-- Main column -->
      <div class="lg:col-span-2">
        <h1 class="text-2xl font-semibold text-[#3b2f1e]">
          {{ appStore.appName }}
        </h1>
        <p class="text-muted-foreground mt-1 text-sm">
          Welcome back. Membership stats and daily summaries will live here.
        </p>

        <p
          v-if="can('roles.manage')"
          class="mt-4 text-sm text-muted-foreground"
        >
          You're a super admin — permission system confirmed. 🎉
        </p>
      </div>

      <!-- Right column: week calendar -->
      <div>
        <DashboardWeekCalendar />
      </div>
    </div>
  </div>
</template>
