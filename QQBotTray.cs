using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

public static class QQBotTrayProgram
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    private const int SW_RESTORE = 9;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const string PANEL_TITLE_KEY = "我是机器人";

    [STAThread]
    private static void Main(string[] args)
    {
        try { SetCurrentProcessExplicitAppUserModelID("CodexQQBotBridge.Tray"); } catch { }

        bool createdNew = false;
        using (Mutex m = new Mutex(true, "CodexQQBotBridgeTrayMutex", out createdNew))
        {
            if (!createdNew) return;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string bridgeScript = Path.Combine(dir, "bridge.mjs");
            string logDir = Path.Combine(dir, "logs");
            string logFile = Path.Combine(logDir, "bridge.log");
            string iconPath = Path.Combine(dir, "bot.ico");
            string node = (args != null && args.Length > 0 && File.Exists(args[0])) ? args[0] : FindNode();
            string panelUrl = "http://127.0.0.1:17890";

            Process bridgeProc = null;
            try
            {
                Directory.CreateDirectory(logDir);
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = node;
                psi.Arguments = "\"" + bridgeScript + "\"";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                string up = Environment.GetEnvironmentVariable("USERPROFILE");
                if (!string.IsNullOrEmpty(up))
                {
                    psi.EnvironmentVariables["HOME"] = up;
                    psi.EnvironmentVariables["USERPROFILE"] = up;
                }
                bridgeProc = Process.Start(psi);
                if (bridgeProc != null)
                {
                    bridgeProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (e.Data != null)
                            File.AppendAllText(Path.Combine(logDir, "stdout.log"), e.Data + Environment.NewLine);
                    };
                    bridgeProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                    {
                        if (e.Data != null)
                            File.AppendAllText(Path.Combine(logDir, "stderr.log"), e.Data + Environment.NewLine);
                    };
                    bridgeProc.BeginOutputReadLine();
                    bridgeProc.BeginErrorReadLine();
                }
            }
            catch { }

            NotifyIcon notify = new NotifyIcon();
            try { notify.Icon = new Icon(iconPath); }
            catch { notify.Icon = SystemIcons.Application; }
            notify.Text = "Codex QQ 桥接";
            notify.Visible = true;

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem mPanel = new ToolStripMenuItem("打开聊天面板");
            mPanel.Click += delegate(object s, EventArgs e) { OpenPanel(panelUrl); };
            ToolStripMenuItem mLog = new ToolStripMenuItem("查看日志");
            mLog.Click += delegate(object s, EventArgs e)
            {
                if (File.Exists(logFile)) Process.Start("notepad.exe", "\"" + logFile + "\"");
            };
            ToolStripMenuItem mSettings = new ToolStripMenuItem("设置…");
            mSettings.Click += delegate(object s, EventArgs e) { ShowSettings(panelUrl); };
            ToolStripMenuItem mExit = new ToolStripMenuItem("退出");
            mExit.Click += delegate(object s, EventArgs e)
            {
                if (bridgeProc != null && !bridgeProc.HasExited)
                {
                    try { bridgeProc.Kill(); } catch { }
                }
                notify.Visible = false;
                Application.Exit();
            };
            menu.Items.Add(mPanel);
            menu.Items.Add(mLog);
            menu.Items.Add(mSettings);
            menu.Items.Add(mExit);
            notify.ContextMenuStrip = menu;
            notify.DoubleClick += delegate(object s, EventArgs e) { OpenPanel(panelUrl); };

            notify.ShowBalloonTip(3000, "Codex QQ 桥接", "已启动，手机 QQ 可直接与我对话", ToolTipIcon.Info);
            Application.Run();
            notify.Dispose();
        }
    }

    private static string FindNode()
    {
        string env = Environment.GetEnvironmentVariable("NODE_PATH");
        if (!string.IsNullOrEmpty(env) && File.Exists(env)) return env;
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("node");
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.CreateNoWindow = true;
            psi.Arguments = "--version";
            Process p = Process.Start(psi);
            if (p.WaitForExit(3000) && p.ExitCode == 0) return "node";
        }
        catch { }
        string[] candidates = new string[]
        {
            @"C:\Program Files\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe")
        };
        for (int i = 0; i < candidates.Length; i++)
            if (File.Exists(candidates[i])) return candidates[i];
        return "node";
    }

    private static void OpenPanel(string panelUrl)
    {
        if (FocusExistingPanel()) return;

        string[] edges = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe")
        };
        for (int i = 0; i < edges.Length; i++)
        {
            if (File.Exists(edges[i]))
            {
                Process.Start(edges[i], "--app=" + panelUrl + " --window-size=420,720");
                return;
            }
        }
        Process.Start(panelUrl);
    }

    // 面板窗口已存在时还原并聚焦，避免双击托盘重复开窗
    private static bool FocusExistingPanel()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            if (!IsWindowVisible(hWnd)) return true;
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hWnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (!string.IsNullOrEmpty(title) && title.IndexOf(PANEL_TITLE_KEY, StringComparison.Ordinal) >= 0)
            {
                found = hWnd;
                return false;
            }
            return true;
        }, IntPtr.Zero);

        if (found == IntPtr.Zero) return false;

        if (IsIconic(found)) ShowWindow(found, SW_RESTORE);
        SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetWindowPos(found, new IntPtr(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetForegroundWindow(found);
        return true;
    }

    private static void ShowSettings(string panelUrl)
    {
        string current = "F:\\iCloud\\iCloudDrive\\Codex";
        try
        {
            using (WebClient wc = new WebClient())
            {
                string json = wc.DownloadString(panelUrl + "/api/settings");
                Match m = Regex.Match(json, "\"icloudDir\":\"(.*?)\"");
                if (m.Success) current = m.Groups[1].Value.Replace("\\\\", "\\");
            }
        }
        catch { }

        Form form = new Form();
        form.Text = "桥接设置";
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.MaximizeBox = false;
        form.MinimizeBox = false;
        form.ClientSize = new Size(480, 135);

        Label lbl = new Label();
        lbl.Text = "iCloud 文件夹路径：";
        lbl.Location = new Point(15, 16);
        lbl.AutoSize = true;

        TextBox txt = new TextBox();
        txt.Text = current;
        txt.Location = new Point(15, 42);
        txt.Width = 350;

        Button btnBrowse = new Button();
        btnBrowse.Text = "浏览…";
        btnBrowse.Location = new Point(372, 41);
        btnBrowse.Width = 75;
        btnBrowse.Click += delegate(object s, EventArgs e)
        {
            using (FolderBrowserDialog dlg = new FolderBrowserDialog())
            {
                dlg.Description = "选择 iCloud 文件夹";
                if (Directory.Exists(txt.Text)) dlg.SelectedPath = txt.Text;
                if (dlg.ShowDialog() == DialogResult.OK) txt.Text = dlg.SelectedPath;
            }
        };

        Button btnOk = new Button();
        btnOk.Text = "保存";
        btnOk.DialogResult = DialogResult.OK;
        btnOk.Location = new Point(190, 88);
        btnOk.Width = 95;

        Button btnCancel = new Button();
        btnCancel.Text = "取消";
        btnCancel.DialogResult = DialogResult.Cancel;
        btnCancel.Location = new Point(295, 88);
        btnCancel.Width = 95;

        form.Controls.Add(lbl);
        form.Controls.Add(txt);
        form.Controls.Add(btnBrowse);
        form.Controls.Add(btnOk);
        form.Controls.Add(btnCancel);
        form.AcceptButton = btnOk;
        form.CancelButton = btnCancel;

        if (form.ShowDialog() == DialogResult.OK)
        {
            string path = txt.Text.Trim().TrimEnd('\\', '/');
            if (path.Length == 0)
            {
                MessageBox.Show("路径不能为空。", "桥接设置", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            try
            {
                using (WebClient wc = new WebClient())
                {
                    wc.Headers[HttpRequestHeader.ContentType] = "application/json; charset=utf-8";
                    string body = "{\"icloudDir\":\"" + path.Replace("\\", "\\\\") + "\"}";
                    string resp = wc.UploadString(panelUrl + "/api/settings", "POST", body);
                    if (resp.IndexOf("\"ok\":true") >= 0)
                        MessageBox.Show("已保存 iCloud 文件夹路径：\r\n" + path, "桥接设置", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    else
                        MessageBox.Show("保存失败：" + resp, "桥接设置", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("保存失败：" + ex.Message, "桥接设置", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        form.Dispose();
    }
}
