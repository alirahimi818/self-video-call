import { createRouter, createWebHistory } from 'vue-router';
import Home from '../views/Home.vue';
import Call from '../views/Call.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/call/:uuid', name: 'call', component: Call, props: true },
  ],
});

export default router;
