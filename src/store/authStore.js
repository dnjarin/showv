import { create } from "zustand";
import { authApi } from "../services/api";

export const useAuth = create((set) => ({
  user: null,
  needsSetup: false,
  loading: true,

  init: async () => {
    try {
      const needsSetup = await authApi.needsSetup();
      const user = needsSetup ? null : await authApi.currentUser();
      set({ needsSetup, user, loading: false });
    } catch {
      set({ loading: false });
    }
  },
  login: async (username, password) => {
    set({ user: await authApi.login(username, password) });
  },
  completeSetup: async (input) => {
    const user = await authApi.completeSetup(input);
    set({ user, needsSetup: false });
  },
  logout: async () => {
    await authApi.logout();
    set({ user: null });
  },
}));