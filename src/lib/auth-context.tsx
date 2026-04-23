import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken, type User } from "./api";

type AuthState = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  bootstrap: (email: string, password: string) => Promise<void>;
  acceptInvite: (token: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    if (!getToken()) { setUser(null); setLoading(false); return; }
    try {
      const { user } = await api<{ user: User }>("/api/auth/me");
      setUser(user);
    } catch {
      setToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const login = async (email: string, password: string) => {
    const { token, user } = await api<{ token: string; user: User }>("/api/auth/login", {
      body: { email, password },
    });
    setToken(token);
    setUser(user);
  };

  const signup = async (email: string, password: string) => {
    const { token, user } = await api<{ token: string; user: User }>("/api/auth/signup", {
      body: { email, password },
    });
    setToken(token);
    setUser(user);
  };

  const bootstrap = async (email: string, password: string) => {
    const { token, user } = await api<{ token: string; user: User }>("/api/auth/bootstrap", {
      body: { email, password },
    });
    setToken(token);
    setUser(user);
  };

  const acceptInvite = async (inviteToken: string, password: string) => {
    const { token, user } = await api<{ token: string; user: User }>("/api/auth/accept-invite", {
      body: { token: inviteToken, password },
    });
    setToken(token);
    setUser(user);
  };

  const logout = () => { setToken(null); setUser(null); };

  return (
    <AuthContext.Provider value={{ user, loading, login, signup, bootstrap, acceptInvite, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
