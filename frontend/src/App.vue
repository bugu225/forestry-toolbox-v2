<template>
  <router-view />
</template>

<script setup></script>

<style>
/* 纯移动端基线：禁止横向溢出、适配安全区与动态视口高度 */
html,
body {
  margin: 0;
  max-width: 100%;
  overflow-x: hidden;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

#app {
  min-height: 100dvh;
  min-height: -webkit-fill-available;
  max-width: 100%;
  box-sizing: border-box;
}
</style>
