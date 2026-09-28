Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class P2PDeskNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_UNION {
        [FieldOffset(0)]
        public MOUSEINPUT mi;
        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUT_UNION u;
    }

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true)]
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

    public static void Mouse(uint flags, uint data = 0) {
        var input = new INPUT {
            type = INPUT_MOUSE,
            u = new INPUT_UNION {
                mi = new MOUSEINPUT {
                    dx = 0,
                    dy = 0,
                    mouseData = data,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        SendInput(
            1,
            new[] { input },
            Marshal.SizeOf(typeof(INPUT))
        );
    }

    public static void Key(ushort virtualKey, bool up) {
        var input = new INPUT {
            type = INPUT_KEYBOARD,
            u = new INPUT_UNION {
                ki = new KEYBDINPUT {
                    wVk = virtualKey,
                    wScan = 0,
                    dwFlags = up ? KEYEVENTF_KEYUP : 0,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        SendInput(
            1,
            new[] { input },
            Marshal.SizeOf(typeof(INPUT))
        );
    }
    
    public static void Unicode(ushort codeUnit, bool up) {
        var input = new INPUT {
            type = INPUT_KEYBOARD,
            u = new INPUT_UNION {
                ki = new KEYBDINPUT {
                    wVk = 0,
                    wScan = codeUnit,
                    dwFlags = 0x0004 | (up ? KEYEVENTF_KEYUP : 0),
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        SendInput(
            1,
            new[] { input },
            Marshal.SizeOf(typeof(INPUT))
        );
    }

}
"@

function Get-VirtualKey([string]$code) {
    if ($code -match '^Key([A-Z])$') {
        return [int][System.Windows.Forms.Keys]$Matches[1]
    }

    if ($code -match '^Digit([0-9])$') {
        return [int]([Enum]::Parse([System.Windows.Forms.Keys], "D" + $Matches[1]))
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

function Send-UnicodeText([string]$text) {
    foreach ($char in $text.ToCharArray()) {
        if ($char -eq [char]10) {
            $enter = [int][System.Windows.Forms.Keys]::Enter
            [P2PDeskNative]::Key([uint16]$enter, $false)
            [P2PDeskNative]::Key([uint16]$enter, $true)
            continue
        }

        [P2PDeskNative]::Unicode([uint16][int][char]$char, $false)
        [P2PDeskNative]::Unicode([uint16][int][char]$char, $true)
    }
}
while ($line = [Console]::ReadLine()) {
    try {
        $packet = $line | ConvertFrom-Json

        switch ($packet.type) {
            "text_input" {
                Send-UnicodeText $packet.text
            }

            "mouse_move" {
                $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $x = [Math]::Max(
                    $screen.Left,
                    [Math]::Min(
                        $screen.Right - 1,
                        [Math]::Round($packet.x * $screen.Width)
                    )
                )
                $y = [Math]::Max(
                    $screen.Top,
                    [Math]::Min(
                        $screen.Bottom - 1,
                        [Math]::Round($packet.y * $screen.Height)
                    )
                )
                [P2PDeskNative]::SetCursorPos($x, $y) | Out-Null
            }

            "mouse_button" {
                $down = switch ($packet.button) {
                    "left"   { [P2PDeskNative]::MOUSEEVENTF_LEFTDOWN }
                    "middle" { [P2PDeskNative]::MOUSEEVENTF_MIDDLEDOWN }
                    "right"  { [P2PDeskNative]::MOUSEEVENTF_RIGHTDOWN }
                    default { 0 }
                }

                $up = switch ($packet.button) {
                    "left"   { [P2PDeskNative]::MOUSEEVENTF_LEFTUP }
                    "middle" { [P2PDeskNative]::MOUSEEVENTF_MIDDLEUP }
                    "right"  { [P2PDeskNative]::MOUSEEVENTF_RIGHTUP }
                    default { 0 }
                }

                if ($down -and $packet.action -eq "down") {
                    [P2PDeskNative]::Mouse($down)
                }
                elseif ($up -and $packet.action -eq "up") {
                    [P2PDeskNative]::Mouse($up)
                }
                elseif ($down -and $up -and $packet.action -eq "double") {
                    [P2PDeskNative]::Mouse($down)
                    [P2PDeskNative]::Mouse($up)
                    Start-Sleep -Milliseconds 45
                    [P2PDeskNative]::Mouse($down)
                    [P2PDeskNative]::Mouse($up)
                }
            }

            "scroll" {
                $wheel = [int][Math]::Max(
                    -1200,
                    [Math]::Min(1200, -$packet.deltaY)
                )
                [P2PDeskNative]::Mouse(
                    [P2PDeskNative]::MOUSEEVENTF_WHEEL,
                    [uint32]$wheel
                )
            }

            "keyboard" {
                $vk = Get-VirtualKey $packet.code
                if ($vk -ne 0) {
                    [P2PDeskNative]::Key(
                        [uint16]$vk,
                        $packet.action -eq "up"
                    )
                }
            }
        }
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
}
