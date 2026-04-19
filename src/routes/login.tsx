import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Package } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { user, login, bootstrap, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean | null>(null);
  const [adminEmail, setAdminEmail] = useState<string>("");

  useEffect(() => {
    if (!loading && user) navigate({ to: "/" });
  }, [user, loading, navigate]);

  useEffect(() => {
    api<{ bootstrapped: boolean; adminEmail: string }>("/api/auth/status")
      .then((r) => {
        setNeedsBootstrap(!r.bootstrapped);
        setAdminEmail(r.adminEmail);
        if (!r.bootstrapped) setEmail(r.adminEmail);
      })
      .catch(() => setNeedsBootstrap(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      if (needsBootstrap) {
        await bootstrap(email, password);
        toast.success("Master admin created. Welcome!");
      } else {
        await login(email, password);
      }
      navigate({ to: "/" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Package className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>{needsBootstrap ? "First-time setup" : "Sign in to Ultrax"}</CardTitle>
          <CardDescription>
            {needsBootstrap
              ? `Create the master admin account for ${adminEmail}.`
              : "Enter your credentials to continue."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={needsBootstrap === true}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={needsBootstrap ? 8 : 1}
                autoComplete={needsBootstrap ? "new-password" : "current-password"}
              />
              {needsBootstrap && (
                <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={submitting || needsBootstrap === null}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {needsBootstrap ? "Create master admin" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
