import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#0b5cff',
    },
    secondary: {
      main: '#1f2937',
    },
    background: {
      default: '#eef2ff',
      paper: '#f8fafc',
    },
  },
  typography: {
    fontFamily: 'Inter, Noto Sans KR, -apple-system, sans-serif',
    h4: {
      fontWeight: 800,
    },
  },
  shape: {
    borderRadius: 12,
  },
});
