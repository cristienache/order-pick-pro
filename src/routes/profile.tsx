import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/app-shell";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Save, ShieldCheck, UserCog } from "lucide-react";
import { toast } from "sonner";
import { api, type User } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export const Route = createFileRoute("/profile")({
  component: () => (
    <RequireAuth>
      <AppShell>
        <ProfilePage />
      </AppShell>
    </RequireAuth>
  ),
  head: () => ({
    meta: [
      { title: "Profile — Ultrax" },
      { name: "description", content: "Manage your account email and password." },
    ],
  }),
});

function ProfilePage() {
  const { user, refresh } = useAuth();
  const [email, setEmail] = useState(user?.email || "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const isMaster = user?.master_admin;

  async function saveEmail() {
    if (!email || email === user?.email) {
      toast.info("Email unchanged");
      return;
    }
    if (!currentPassword) {
      toast.error("Confirm your current password to change email");
      return;
    }
    setSavingProfile(true);
    try {
      const r = await api<{ user: User }>("/api/auth/me", {
        method: "PUT",
        body: { email, current_password: currentPassword },
      });
      toast.success("Email updated");
      setCurrentPassword("");
      await refresh();
      setEmail(r.user.email);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSavingProfile(false);
    }
  }

  async function savePassword() {
    if (newPassword.length < 8) {
      toast.error("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords don't match");
      return;
    }
    if (!currentPassword) {
      toast.error("Enter your current password");
      return;
    }
    setSavingPassword(true);
    try {
      await api("/api/auth/me", {
        method: "PUT",
        body: { current_password: currentPassword, new_password: newPassword },
      });
      toast.success("Password updated");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UserCog}
        accent="violet"
        eyebrow="Account"
        title="Profile settings"
        description="Update your sign-in email and password. Re-enter your current password to confirm any change."
      />

      {/* Identity card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Account
            {user?.role === "admin" && (
              <Badge variant="secondary" className="rounded-full text-[10px] gap-1">
                <ShieldCheck className="h-3 w-3" />
                {isMaster ? "Master admin" : "Admin"}
              </Badge>
            )}
            {!isMaster && user?.role !== "admin" && (
              <Badge variant="secondary" className="rounded-full text-[10px]">Member</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Your sign-in email — used for login and notifications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isMaster}
              placeholder="you@example.com"
            />
            {isMaster && (
              <p className="text-xs text-muted-foreground">
                Master admin email is fixed via the <code className="text-xs">ADMIN_EMAIL</code> env var.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="current_for_email">Current password</Label>
            <Input
              id="current_for_email"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>
          <Button
            onClick={saveEmail}
            disabled={savingProfile || isMaster || email === user?.email}
            className="gap-1.5"
          >
            {savingProfile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Update email
          </Button>
        </CardContent>
      </Card>

      {/* Password card */}
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Use a strong password — minimum 8 characters.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="current_password">Current password</Label>
            <Input
              id="current_password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new_password">New password</Label>
            <Input
              id="new_password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm_password">Confirm new password</Label>
            <Input
              id="confirm_password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="Re-enter the new password"
            />
          </div>
          <Button onClick={savePassword} disabled={savingPassword} className="gap-1.5">
            {savingPassword ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Update password
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
