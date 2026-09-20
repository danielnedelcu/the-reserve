<script setup lang="ts">
const { can, load } = usePermissions();
await load();
</script>

<template>
  <div class="mx-auto w-full p-6 md:p-10">
    <div class="grid gap-8 xl:grid-cols-[minmax(0,1fr)_436px]">
      <!-- Main column -->
      <div class="">
        <DashboardFrontDeskToday />
        <DashboardKpiCards class="mt-6" />
        <DashboardBookingsChart class="mt-6" />
      </div>

      <!-- Right column: week calendar -->
      <div class="grid gap-8 md:grid-cols-2 xl:block">
        <DashboardWeekCalendar />
        <DashboardNewClients
          v-if="can('clients.view')"
          class="md:mt-0 xl:mt-8"
        />
      </div>
    </div>
  </div>
</template>
