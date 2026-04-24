import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { Loader2 } from "lucide-react";

export function RequireAuth({
  children,
  adminOnly = false,
  masterAdminOnly = false,
}: {
  children: ReactNode;
  adminOnly?: boolean;
  masterAdminOnly?: boolean;
}) {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  const blocked =
    !user ||
    (masterAdminOnly && !user.master_admin) ||
    (adminOnly && user.role !== "admin");

  useEffect(() => {
    if (loading) return;
    if (!user) navigate({ to: "/login" });
    else if (masterAdminOnly && !user.master_admin) navigate({ to: "/" });
    else if (adminOnly && user.role !== "admin") navigate({ to: "/" });
  }, [user, loading, adminOnly, masterAdminOnly, navigate]);

  if (loading || blocked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <>{children}</>;
}
