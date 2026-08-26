import { useState } from 'react';
import ShellSettingsView from '@stevederico/skateboard-ui/SettingsView';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@stevederico/skateboard-ui/shadcn/ui/card';
import { Label } from '@stevederico/skateboard-ui/shadcn/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stevederico/skateboard-ui/shadcn/ui/select';
import { readRefreshMs, writeRefreshMs, REFRESH_OPTIONS } from '../lib/settings';

/**
 * Shell settings plus refresh interval for usage polling.
 *
 * @returns Settings view
 */
export default function SettingsView() {
  const [refreshMs, setRefreshMs] = useState(() => String(readRefreshMs()));

  const handleRefresh = (value: string) => {
    setRefreshMs(value);
    writeRefreshMs(Number(value));
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto [&>div:first-child>div:last-child]:hidden">
      <ShellSettingsView />
      <div className="flex flex-col items-center px-4 pb-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Usage Refresh</CardTitle>
            <CardDescription>
              How often Quota reloads Cursor, Grok, Claude, and OpenCode.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-2">
              <Label htmlFor="refresh-interval">Refresh Interval</Label>
              <Select value={refreshMs} onValueChange={handleRefresh}>
                <SelectTrigger id="refresh-interval" aria-label="Refresh Interval">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REFRESH_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
