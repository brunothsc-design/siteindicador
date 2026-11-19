export interface CaptureEnvironmentCheck {
  supported: boolean;
  reason:
    | 'OK'
    | 'INSECURE_CONTEXT'
    | 'API_UNAVAILABLE'
    | 'IFRAME_POLICY_BLOCKED';
  message: string | null;
}

interface PolicyCarrier {
  permissionsPolicy?: {
    allowsFeature?: (feature: string) => boolean;
  };
  featurePolicy?: {
    allowsFeature?: (feature: string) => boolean;
  };
}

export interface WindowLike {
  isSecureContext: boolean;
  location?: { hostname?: string };
  self: unknown;
  top: unknown;
}

export function checkDisplayCaptureEnvironment(
  win: WindowLike = window,
  nav: Pick<Navigator, 'mediaDevices'> | undefined = typeof navigator !== 'undefined'
    ? navigator
    : undefined,
  doc: PolicyCarrier | undefined = typeof document !== 'undefined'
    ? (document as unknown as PolicyCarrier)
    : undefined
): CaptureEnvironmentCheck {
  const hostname = win.location?.hostname ?? '';
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1';
  const isSecure = Boolean(win.isSecureContext) || isLocalhost;

  if (!isSecure) {
    return {
      supported: false,
      reason: 'INSECURE_CONTEXT',
      message:
        'A captura de tela exige contexto seguro (HTTPS ou localhost). Abra o aplicativo via HTTPS ou localhost.',
    };
  }

  if (
    !nav ||
    !nav.mediaDevices ||
    typeof nav.mediaDevices.getDisplayMedia !== 'function'
  ) {
    return {
      supported: false,
      reason: 'API_UNAVAILABLE',
      message:
        'Captura de tela indisponível neste navegador ou Preview (navigator.mediaDevices.getDisplayMedia não suportado).',
    };
  }

  const isInIframe = (() => {
    try {
      return win.self !== win.top;
    } catch {
      return true;
    }
  })();

  const policyAllowed =
    doc?.permissionsPolicy?.allowsFeature?.('display-capture') ??
    doc?.featurePolicy?.allowsFeature?.('display-capture');

  if (policyAllowed === false) {
    return {
      supported: false,
      reason: 'IFRAME_POLICY_BLOCKED',
      message: isInIframe
        ? 'O Preview do Google AI Studio bloqueia a captura de tela dentro do iframe (política display-capture). Abra o aplicativo em uma nova aba do navegador para autorizar a captura.'
        : 'A política de permissões do navegador bloqueou a captura de tela (display-capture).',
    };
  }

  return {
    supported: true,
    reason: 'OK',
    message: null,
  };
}

export function classifyDisplayCaptureError(
  err: unknown,
  elapsedMs: number,
  isInIframe: boolean
): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  const rawMsg = err instanceof Error ? err.message : String(err ?? '');
  const msg = rawMsg.toLowerCase();

  if (
    msg.includes('permissions policy') ||
    msg.includes('feature policy') ||
    msg.includes('disallowed') ||
    (name === 'NotAllowedError' && isInIframe && elapsedMs < 350)
  ) {
    return isInIframe
      ? 'O Preview do Google AI Studio não permite captura de tela neste iframe. Abra o aplicativo em uma nova aba do navegador e clique em ATIVAR ANÁLISE.'
      : 'Captura de tela bloqueada pela política de permissões do navegador.';
  }

  if (name === 'AbortError') {
    return 'Seleção de tela cancelada. Clique em ATIVAR ANÁLISE para escolher uma janela.';
  }

  if (name === 'NotAllowedError') {
    if (msg.includes('by system')) {
      return 'Permissão de gravação de tela negada pelo sistema operacional.';
    }
    if (elapsedMs >= 350 && !msg.includes('policy')) {
      return 'Compartilhamento cancelado antes de selecionar a janela. Clique em ATIVAR ANÁLISE para tentar novamente.';
    }
    return 'Permissão de captura de tela não concedida pelo navegador.';
  }

  if (name === 'NotFoundError') {
    return 'Nenhuma tela ou janela disponível para captura foi encontrada.';
  }

  if (name === 'NotReadableError') {
    return 'Não foi possível ler a janela selecionada. Tente selecionar outra janela ou a tela inteira.';
  }

  if (name === 'NotSupportedError' || name === 'TypeError') {
    return 'API de captura de tela indisponível neste navegador.';
  }

  return 'Não foi possível iniciar a captura de tela.';
}
