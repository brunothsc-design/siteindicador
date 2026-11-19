using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.Win32;

namespace ChartPulseOverlaySetup
{
    internal sealed class SetupForm : Form
    {
        private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValueName = "ChartPulseAIOverlay";

        private readonly CheckBox _autoStartCheck;
        private readonly Button _installBtn;
        private readonly Button _uninstallBtn;
        private readonly Label _statusLabel;

        private static string InstallDir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "ChartPulseAI",
                    "Overlay"
                );
            }
        }

        private static string InstalledExePath
        {
            get { return Path.Combine(InstallDir, "ChartPulseOverlay.exe"); }
        }

        public SetupForm()
        {
            Text = "ChartPulse AI — Instalador do Overlay Nativo";
            ClientSize = new Size(460, 235);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(15, 20, 28);
            ForeColor = Color.FromArgb(241, 245, 249);

            Label title = new Label
            {
                Text = "ChartPulse AI — Overlay Nativo do Windows",
                Font = new Font("Segoe UI", 11.5f, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(20, 18)
            };

            Label desc = new Label
            {
                Text = "Instala o componente transparente que acompanha a janela da corretora\n" +
                       "e recebe sinais COMPRA / VENDA com segurança pelo navegador (Netlify).",
                Font = new Font("Segoe UI", 9f),
                ForeColor = Color.FromArgb(148, 163, 184),
                AutoSize = true,
                Location = new Point(20, 48)
            };

            _autoStartCheck = new CheckBox
            {
                Text = "Autorizar inicialização automática junto com o Windows",
                Font = new Font("Segoe UI", 9.5f),
                Checked = true,
                AutoSize = true,
                Location = new Point(22, 98)
            };

            _statusLabel = new Label
            {
                Text = File.Exists(InstalledExePath)
                    ? "Componente já instalado em: " + InstalledExePath
                    : "Pronto para instalar em: " + InstallDir,
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(148, 163, 184),
                MaximumSize = new Size(420, 40),
                AutoSize = true,
                Location = new Point(20, 132)
            };

            _installBtn = new Button
            {
                Text = "Instalar e Iniciar",
                BackColor = Color.FromArgb(22, 163, 74),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Size = new Size(150, 36),
                Location = new Point(20, 180)
            };
            _installBtn.FlatAppearance.BorderSize = 0;
            _installBtn.Click += OnInstallClick;

            _uninstallBtn = new Button
            {
                Text = "Desinstalar",
                BackColor = Color.FromArgb(51, 65, 85),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Font = new Font("Segoe UI", 9f),
                Size = new Size(110, 36),
                Location = new Point(182, 180)
            };
            _uninstallBtn.FlatAppearance.BorderSize = 0;
            _uninstallBtn.Click += OnUninstallClick;

            Controls.Add(title);
            Controls.Add(desc);
            Controls.Add(_autoStartCheck);
            Controls.Add(_statusLabel);
            Controls.Add(_installBtn);
            Controls.Add(_uninstallBtn);
        }

        private static void StopRunningInstances()
        {
            foreach (Process proc in Process.GetProcessesByName("ChartPulseOverlay"))
            {
                try
                {
                    proc.Kill();
                    proc.WaitForExit(2000);
                }
                catch
                {
                    // Ignore process exit errors
                }
            }
        }

        private void OnInstallClick(object sender, EventArgs e)
        {
            try
            {
                StopRunningInstances();
                Directory.CreateDirectory(InstallDir);

                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("ChartPulseOverlay.exe"))
                {
                    if (resStream == null)
                    {
                        MessageBox.Show(
                            "Recurso ChartPulseOverlay.exe não embutido neste instalador.",
                            "ChartPulse AI",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                        return;
                    }
                    using (FileStream fs = new FileStream(InstalledExePath, FileMode.Create, FileAccess.Write))
                    {
                        resStream.CopyTo(fs);
                    }
                }

                using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
                {
                    if (runKey != null)
                    {
                        if (_autoStartCheck.Checked)
                        {
                            runKey.SetValue(RunValueName, "\"" + InstalledExePath + "\"");
                        }
                        else if (runKey.GetValue(RunValueName) != null)
                        {
                            runKey.DeleteValue(RunValueName, false);
                        }
                    }
                }

                Process.Start(new ProcessStartInfo
                {
                    FileName = InstalledExePath,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                });

                _statusLabel.ForeColor = Color.FromArgb(34, 197, 94);
                _statusLabel.Text = _autoStartCheck.Checked
                    ? "Instalado, iniciado em segundo plano e configurado para abrir com o Windows."
                    : "Instalado e iniciado em segundo plano (inicialização automática não marcada).";
            }
            catch (Exception ex)
            {
                MessageBox.Show("Falha na instalação: " + ex.Message, "ChartPulse AI", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void OnUninstallClick(object sender, EventArgs e)
        {
            try
            {
                StopRunningInstances();
                using (RegistryKey runKey = Registry.CurrentUser.OpenSubKey(RunKeyPath, true))
                {
                    if (runKey != null && runKey.GetValue(RunValueName) != null)
                    {
                        runKey.DeleteValue(RunValueName, false);
                    }
                }

                if (File.Exists(InstalledExePath))
                {
                    File.Delete(InstalledExePath);
                }

                _statusLabel.ForeColor = Color.FromArgb(248, 113, 113);
                _statusLabel.Text = "Componente removido e inicialização automática desativada.";
            }
            catch (Exception ex)
            {
                MessageBox.Show("Falha ao desinstalar: " + ex.Message, "ChartPulse AI", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new SetupForm());
        }
    }
}
