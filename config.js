/* =====================================================================
   config.js — acá pego mis datos de Supabase y listo, no toco nada
   más de los otros archivos.

   Cómo lo consigo (una sola vez, con un proyecto de Supabase NUEVO,
   separado del que usa el fixture):
   1. Entro a supabase.com, creo un proyecto nuevo (gratis).
   2. Corro el archivo supabase-ruleta.sql en el SQL Editor del proyecto.
   3. Voy a Project Settings > API.
   4. Copio el "Project URL" y lo pego abajo en SUPABASE_URL.
   5. Copio la key que dice "anon" / "public" y la pego en
      SUPABASE_ANON_KEY. (Esa key es pública, va en el código del
      sitio sin drama, para eso están las políticas del SQL).

   Esto NO necesita nada de la streamer aparte de dejarme crear el
   proyecto (o pasarme estos dos datos si lo crea ella). El canal de
   Twitch que escucha el chat ya está fijo en script.js (TWITCH_CHANNEL).
   ===================================================================== */

window.SUPABASE_URL = "https://rnszzfywsizcexfaingo.supabase.co";
window.SUPABASE_ANON_KEY = "sb_publishable_L7pNTEuZVO624LSJ-cEx-Q_22UyyN0E";
