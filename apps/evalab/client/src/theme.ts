import type { GlobalThemeOverrides } from 'naive-ui'

const font =
  '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif'

export const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#1D4ED8',
    primaryColorHover: '#1E40AF',
    primaryColorPressed: '#1E3A8A',
    primaryColorSuppl: '#2563EB',
    infoColor: '#1D4ED8',
    successColor: '#0F766E',
    warningColor: '#A16207',
    errorColor: '#B42318',
    textColorBase: '#1C2430',
    textColor1: '#1C2430',
    textColor2: '#3E4A5C',
    textColor3: '#5C6B7E',
    borderColor: '#E4DDD2',
    dividerColor: '#E7E1D6',
    bodyColor: '#F3EFE7',
    cardColor: '#FFFCF8',
    modalColor: '#FFFCF8',
    popoverColor: '#FFFCF8',
    hoverColor: '#F6F1E8',
    borderRadius: '8px',
    borderRadiusSmall: '6px',
    fontSize: '14px',
    fontSizeMini: '12px',
    fontSizeSmall: '13px',
    fontSizeMedium: '14px',
    fontFamily: font,
    fontFamilyMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    heightMedium: '36px',
  },
  Button: {
    fontWeight: '600',
    borderRadiusMedium: '8px',
    heightMedium: '36px',
  },
  Input: {
    borderRadius: '8px',
    heightMedium: '36px',
  },
  Tag: {
    borderRadius: '999px',
  },
}
