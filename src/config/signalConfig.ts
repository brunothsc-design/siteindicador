/**
 * Configuração centralizada da confiança mínima para validação e exibição de sinais COMPRA e VENDA.
 *
 * ATENÇÃO — CONFIGURAÇÃO TEMPORÁRIA DE TESTE ATIVA:
 * - Configuração original de produção preservada em: PRODUCTION_MIN_SIGNAL_CONFIDENCE = 90
 * - Configuração temporária exclusiva para testes: TEMPORARY_TEST_MIN_SIGNAL_CONFIDENCE = 65
 *
 * COMO RESTAURAR PARA PRODUÇÃO (90%):
 * Altere `USE_TEMPORARY_TEST_CONFIDENCE` abaixo de `true` para `false`.
 */
export const PRODUCTION_MIN_SIGNAL_CONFIDENCE = 90 as const;
export const TEMPORARY_TEST_MIN_SIGNAL_CONFIDENCE = 65 as const;

// MODO TEMPORÁRIO DE TESTE: altere para `false` para restaurar imediatamente o limite de 90%.
export const USE_TEMPORARY_TEST_CONFIDENCE = true;

export const MIN_SIGNAL_CONFIDENCE: number = USE_TEMPORARY_TEST_CONFIDENCE
  ? TEMPORARY_TEST_MIN_SIGNAL_CONFIDENCE
  : PRODUCTION_MIN_SIGNAL_CONFIDENCE;

export function isSignalConfidenceValid(confidence: number): boolean {
  return Number.isFinite(confidence) && confidence >= MIN_SIGNAL_CONFIDENCE;
}
