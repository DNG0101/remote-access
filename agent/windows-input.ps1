Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class P2PDeskNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public const uint INPUT_MOUSE = 0;
    public const uint INPUT_KEYBOARD = 1;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;

    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static void Mouse(int buttonFlags, int data = 0) {
        var input = new INPUT {
            type = INPUT_MOUSE,
            mi = new MOUSEINPUT {
                dx = 0,
                dy = 0,
                mouseData = (uint)data,
                dwFlags = (uint)buttonFlags,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            }
        };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Key(int virtualKey, bool up) {
        var input = new INPUT {
            type = INPUT_KEYBOARD,
            mi = new MOUSEINPUT {
                dx = virtualKey,
                dy = 0,
                mouseData = 0,
                dwFlags = up ? KEYEVENTF_KEYUP : 0,
                time = 0,
                dwExtraInfo = IntPtr.Zero
            }
        };
        SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }
}
"@

function Get-VirtualKey([string]$code) {
    if ($code -match '^Key([A-Z])$') {
        return [int][System.Windows.Forms.Keys]::$($Matches[1])
    }

    if ($code -match '^Digit([0-9])$') {
        return [int][System.Windows.Forms.Keys]::($("D" + $Matches[1]))
    }

    $map = @{
        Enter = [System.Windows.Forms.Keys]::Enter
        Escape = [System.Windows.Forms.Keys]::Escape
        Tab = [System.Windows.Forms.Keys]::Tab
        Backspace = [System.Windows.Forms.Keys]::Back
        Delete = [System.Windows.Forms.Keys]::Delete
        Insert = [System.Windows.Forms.Keys]::Insert
        Home = [System.Windows.Forms.Keys]::Home
        End = [System.Windows.Forms.Keys]::End
        PageUp = [System.Windows.Forms.Keys]::PageUp
        PageDown = [System.Windows.Forms.Keys]::PageDown
        ArrowUp = [System.Windows.Forms.Keys]::Up
        ArrowDown = [System.Windows.Forms.Keys]::Down
        ArrowLeft = [System.Windows.Forms.Keys]::Left
        ArrowRight = [System.Windows.Forms.Keys]::Right
        Space = [System.Windows.Forms.Keys]::Space
        F1 = [System.Windows.Forms.Keys]::F1
        F2 = [System.Windows.Forms.Keys]::F2
        F3 = [System.Windows.Forms.Keys]::F3
        F4 = [System.Windows.Forms.Keys]::F4
        F5 = [System.Windows.Forms.Keys]::F5
        F6 = [System.Windows.Forms.Keys]::F6
        F7 = [System.Windows.Forms.Keys]::F7
        F8 = [System.Windows.Forms.Keys]::F8
        F9 = [System.Windows.Forms.Keys]::F9
        F10 = [System.Windows.Forms.Keys]::F10
        F11 = [System.Windows.Forms.Keys]::F11
        F12 = [System.Windows.Forms.Keys]::F12
        ShiftLeft = [System.Windows.Forms.Keys]::LShiftKey
        ShiftRight = [System.Windows.Forms.Keys]::RShiftKey
        ControlLeft = [System.Windows.Forms.Keys]::LControlKey
        ControlRight = [System.Windows.Forms.Keys]::RControlKey
        AltLeft = [System.Windows.Forms.Keys]::LMenu
        AltRight = [System.Windows.Forms.Keys]::RMenu
        MetaLeft = [System.Windows.Forms.Keys]::LWin
        MetaRight = [System.Windows.Forms.Keys]::RWin
    }

    if ($map.ContainsKey($code)) {
        return [int]$map[$code]
    }

    return 0
}

while ($line = [Console]::ReadLine()) {
    try {
        $packet = $line | ConvertFrom-Json

        switch ($packet.type) {
            "mouse_move" {
                $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $x = [Math]::Max($screen.Left, [Math]::Min($screen.Right - 1, [Math]::Round($packet.x * $screen.Width)))
                $y = [Math]::Max($screen.Top, [Math]::Min($screen.Bottom - 1, [Math]::Round($packet.y * $screen.Height)))
                [P2PDeskNative]::SetCursorPos($x, $y) | Out-Null
            }
            "mouse_button" {
                $leftDown = [int][P2PDeskNative]::MOUSEEVENTF_LEFTDOWN
                $leftUp = [int][P2PDeskNative]::MOUSEEVENTF_LEFTUP
                $middleDown = [int][P2PDeskNative]::MOUSEEVENTF_MIDDLEDOWN
                $middleUp = [int][P2PDeskNative]::MOUSEEVENTF_MIDDLEUP
                $rightDown = [int][P2PDeskNative]::MOUSEEVENTF_RIGHTDOWN
                $rightUp = [int][P2PDeskNative]::MOUSEEVENTF_RIGHTUP

                $down = switch ($packet.button) {
                    "left" { $leftDown }
                    "middle" { $middleDown }
                    "right" { $rightDown }
                    default { 0 }
                }

                $up = switch ($packet.button) {
                    "left" { $leftUp }
                    "middle" { $middleUp }
                    "right" { $rightUp }
                    default { 0 }
                }

                if ($down -and $packet.action -in @("down","double")) {
                    [P2PDeskNative]::Mouse($down)
                }
                if ($up -and $packet.action -in @("up","double")) {
                    [P2PDeskNative]::Mouse($up)
                }
                if ($packet.action -eq "double") {
                    Start-Sleep -Milliseconds 45
                    [P2PDeskNative]::Mouse($down)
                    [P2PDeskNative]::Mouse($up)
                }
            }
            "scroll" {
                $wheel = [int][Math]::Max(-1200, [Math]::Min(1200, -$packet.deltaY))
                [P2PDeskNative]::Mouse([P2PDeskNative]::MOUSEEVENTF_WHEEL, $wheel)
            }
            "keyboard" {
                $vk = Get-VirtualKey $packet.code
                if ($vk -ne 0) {
                    [P2PDeskNative]::Key($vk, $packet.action -eq "up")
                }
            }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
