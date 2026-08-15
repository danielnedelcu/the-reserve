<template>
  <div>
    <NuxtLoadingIndicator color="oklch(58.6% 0.253 17.585)" />
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <UiSonner rich-colors position="top-right" />
  </div>
</template>

<script setup lang="ts">
// nothing needed — UiSonner is auto-imported from app/components/Ui/
</script>
