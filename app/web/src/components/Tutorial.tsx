/**
 * Tutorial curto do sistema. Abre sozinho na primeira vez que a pessoa entra neste navegador
 * e pode ser aberto de novo em Configurações → Como usar.
 */
import { useState } from "react";
import { CalendarRange, History, KeyRound, Printer, Settings, Sparkles, Users } from "lucide-react";
import type { Me } from "@/lib/api";
import { canEditVolunteers } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";

interface Step {
  icon: React.ElementType;
  title: string;
  body: React.ReactNode;
}

function steps(me: Me): Step[] {
  const admin = me.role === "admin";
  const list: (Step | false)[] = [
    {
      icon: Sparkles,
      title: "Bem-vindo à Escala de voluntários",
      body: (
        <p>
          Aqui você monta a escala de cada culto: marca quem veio, o sistema sugere onde cada pessoa fica e você ajusta o que
          quiser. São só alguns passos, mostrados a seguir.
        </p>
      ),
    },
    {
      icon: CalendarRange,
      title: "Escala: quatro passos",
      body: (
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            <b>Qual culto?</b> Confira a data e a equipe que vai servir.
          </li>
          <li>
            <b>Quem faltou?</b> Todos começam presentes. Toque no nome de quem não veio. (Na equipe Eventos é ao
            contrário: você escolhe quem vai servir.)
          </li>
          <li>
            <b>Fazer a escala.</b> O sistema distribui as pessoas pelas posições, seguindo as regras.
          </li>
          <li>
            <b>Confira e troque.</b> Toque num nome para trocar a pessoa. Cada mudança é salva sozinha.
          </li>
        </ol>
      ),
    },
    {
      icon: Printer,
      title: "Imprimir ou mandar para a equipe",
      body: (
        <p>
          Com a escala pronta, use o botão <b>Imprimir ou baixar</b>, no alto da tela da escala. Dá para imprimir ou baixar a
          lista e o mapa do templo como imagem, para mandar no grupo.
        </p>
      ),
    },
    {
      icon: Users,
      title: "Voluntários",
      body: canEditVolunteers(me) ? (
        <p>
          O cadastro de todos que servem. Toque no nome para editar, marque onde cada pessoa pode servir (berçário, cozinha,
          recepção…) e desligue <b>Ativo</b> de quem não deve entrar nas próximas escalas.
        </p>
      ) : (
        <p>
          O cadastro de todos que servem: a equipe de cada um, onde pode servir e os recados. Toque no nome para ver os
          detalhes.
        </p>
      ),
    },
    {
      icon: History,
      title: "Histórico e faltas",
      body: <p>Quem faltou mais, quantas vezes cada pessoa serviu em cada lugar e as escalas passadas, para o rodízio ficar justo.</p>,
    },
    admin && {
      icon: KeyRound,
      title: "Só para administradores",
      body: (
        <p>
          Em <b>Acessos</b> você libera quem pode entrar no sistema e define as regras dos coordenadores. Em{" "}
          <b>Atividade</b> você vê quem fez o quê.
        </p>
      ),
    },
    {
      icon: Settings,
      title: "Configurações",
      body: (
        <p>
          No pé do menu ficam o tema escuro, a troca de senha e o botão de sair. Este tutorial também fica lá, em{" "}
          <b>Como usar</b>, se quiser ver de novo.
        </p>
      ),
    },
  ];
  return list.filter((s): s is Step => !!s);
}

export function Tutorial({ me, open, onOpenChange }: { me: Me; open: boolean; onOpenChange: (open: boolean) => void }) {
  const all = steps(me);
  const [i, setI] = useState(0);
  const step = all[i];
  const Icon = step.icon;
  const last = i === all.length - 1;

  const change = (o: boolean) => {
    onOpenChange(o);
    if (!o) setI(0); // na próxima vez, recomeça do início
  };

  return (
    <Dialog open={open} onOpenChange={change} title={step.title}>
      <div className="flex min-h-36 gap-3 text-sm leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Icon className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">{step.body}</div>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <div className="flex flex-1 gap-1.5" aria-label={`Passo ${i + 1} de ${all.length}`}>
          {all.map((s, k) => (
            <button
              key={s.title}
              onClick={() => setI(k)}
              aria-label={`Ir para o passo ${k + 1}`}
              className={cn("h-1.5 rounded-full transition-all", k === i ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30")}
            />
          ))}
        </div>
        {i > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => setI(i - 1)}>
            Voltar
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => change(false)}>
            Pular
          </Button>
        )}
        <Button size="sm" onClick={() => (last ? change(false) : setI(i + 1))}>
          {last ? "Começar" : "Próximo"}
        </Button>
      </div>
    </Dialog>
  );
}

/** Já viu o tutorial neste navegador? Guardado por e-mail: outra conta no mesmo aparelho também vê. */
const seenKey = (email: string) => `tutorial-visto:${email}`;

export function tutorialSeen(email: string): boolean {
  try {
    return localStorage.getItem(seenKey(email)) === "1";
  } catch {
    return true; // sem armazenamento local: não insiste a cada visita
  }
}

export function markTutorialSeen(email: string) {
  try {
    localStorage.setItem(seenKey(email), "1");
  } catch {
    /* sem armazenamento local */
  }
}
