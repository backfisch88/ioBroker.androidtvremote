import React, { useEffect, useRef, useState } from 'react';
import { Box, Button, FormControl, InputLabel, MenuItem, Select, Typography, CircularProgress } from '@mui/material';
import type { ConfigGenericProps } from '@iobroker/json-config';

type Device = { value: string; label: string };
type Status = { running: boolean; devices: Device[]; error?: string };

const words: Record<string, string[]> = {
  de: ['Gerät automatisch erkennen', 'Suchen', 'Suche nach Geräten …', 'Keine Geräte gefunden', '1 Gerät gefunden', '{n} Geräte gefunden', 'Gerät auswählen', 'Gerät auswählen …', 'Adapter ist nicht erreichbar'],
  en: ['Discover Android TV devices', 'Search', 'Searching for devices …', 'No devices found', '1 device found', '{n} devices found', 'Select device', 'Select a device …', 'Adapter is unavailable'],
  es: ['Detectar dispositivos Android TV', 'Buscar', 'Buscando dispositivos …', 'No se encontraron dispositivos', '1 dispositivo encontrado', '{n} dispositivos encontrados', 'Seleccionar dispositivo', 'Selecciona un dispositivo …', 'Adaptador no disponible'],
  fr: ['Détecter les appareils Android TV', 'Rechercher', 'Recherche des appareils …', 'Aucun appareil trouvé', '1 appareil trouvé', '{n} appareils trouvés', 'Sélectionner un appareil', 'Choisir un appareil …', 'Adaptateur indisponible'],
  it: ['Rileva dispositivi Android TV', 'Cerca', 'Ricerca dispositivi …', 'Nessun dispositivo trovato', '1 dispositivo trovato', '{n} dispositivi trovati', 'Seleziona dispositivo', 'Seleziona un dispositivo …', 'Adattatore non disponibile'],
  nl: ['Android TV-apparaten zoeken', 'Zoeken', 'Apparaten zoeken …', 'Geen apparaten gevonden', '1 apparaat gevonden', '{n} apparaten gevonden', 'Apparaat selecteren', 'Selecteer een apparaat …', 'Adapter niet beschikbaar'],
  pl: ['Wykryj urządzenia Android TV', 'Szukaj', 'Wyszukiwanie urządzeń …', 'Nie znaleziono urządzeń', 'Znaleziono 1 urządzenie', 'Znaleziono {n} urządzeń', 'Wybierz urządzenie', 'Wybierz urządzenie …', 'Adapter niedostępny'],
  pt: ['Encontrar dispositivos Android TV', 'Pesquisar', 'A procurar dispositivos …', 'Nenhum dispositivo encontrado', '1 dispositivo encontrado', '{n} dispositivos encontrados', 'Selecionar dispositivo', 'Selecione um dispositivo …', 'Adaptador indisponível'],
  ru: ['Поиск устройств Android TV', 'Искать', 'Поиск устройств …', 'Устройства не найдены', 'Найдено 1 устройство', 'Найдено устройств: {n}', 'Выбрать устройство', 'Выберите устройство …', 'Адаптер недоступен'],
  uk: ['Пошук пристроїв Android TV', 'Шукати', 'Пошук пристроїв …', 'Пристроїв не знайдено', 'Знайдено 1 пристрій', 'Знайдено пристроїв: {n}', 'Вибрати пристрій', 'Виберіть пристрій …', 'Адаптер недоступний'],
  'zh-cn': ['发现 Android TV 设备', '搜索', '正在搜索设备…', '未找到设备', '找到 1 台设备', '找到 {n} 台设备', '选择设备', '请选择设备…', '适配器不可用'],
};

function DeviceDiscovery(props: ConfigGenericProps): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ running: false, devices: [] });
  const [reachable, setReachable] = useState(true);
  const busy = useRef(false);
  const lang = (navigator.language || 'en').toLowerCase();
  const locale = lang.startsWith('zh') ? 'zh-cn' : lang.split('-')[0];
  const tr = words[locale] || words.en;
  const instance = `${props.oContext.adapterName}.${props.oContext.instance}`;
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const result = await props.oContext.socket.sendTo(instance, 'getDiscoveryStatus', {});
      if (result && Array.isArray(result.devices)) {
        setStatus({ running: !!result.running, devices: result.devices });
        setReachable(true);
      } else {
        setReachable(false);
      }
    } catch {
      setReachable(false);
    } finally {
      busy.current = false;
    }
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [instance]);
  const start = async () => {
    setStatus(prev => ({ ...prev, running: true }));
    try {
      await props.oContext.socket.sendTo(instance, 'startDiscovery', {});
      await refresh();
    } catch {
      setReachable(false);
      setStatus(prev => ({ ...prev, running: false }));
    }
  };
  const count = status.devices.length;
  const message = !reachable ? tr[8] : status.running ? tr[2] : count === 0 ? tr[3] : count === 1 ? tr[4] : tr[5].replace('{n}', String(count));
  const host = String(props.data.host || '');
  return <Box sx={{ width: '100%', py: 1 }}>
    <Typography variant="subtitle2" sx={{ mb: 1 }}>{tr[0]}</Typography>
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
      {status.running && <CircularProgress size={19} />}
      <Typography variant="body2" aria-live="polite">{message}</Typography>
      <Button variant="outlined" size="small" disabled={status.running || !reachable} onClick={() => void start()}>{tr[1]}</Button>
    </Box>
    <FormControl fullWidth size="small">
      <InputLabel id="androidtv-discovery-label">{tr[6]}</InputLabel>
      <Select labelId="androidtv-discovery-label" label={tr[6]} value={status.devices.some(d => d.value === host) ? host : ''}
        displayEmpty={false} disabled={!reachable || status.running || count === 0}
        onChange={e => props.onChange('host', e.target.value)}>
        <MenuItem value="" disabled>{tr[7]}</MenuItem>
        {status.devices.map(d => <MenuItem key={d.value} value={d.value}>{d.label}</MenuItem>)}
      </Select>
    </FormControl>
  </Box>;
}

export default { DeviceDiscovery };
