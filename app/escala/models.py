from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class Volunteer:
    id: int
    name: str
    gender: str  # "Masculino" / "Feminino"
    team: str
    active: bool
    can_bercario: bool
    can_cozinha: bool
    can_recepcao: bool
    can_banheiro: bool
    can_limpar_altar: bool
    observation: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Position:
    code: str
    name: str
    category: str
    allowed_gender: str  # "Qualquer" / "Masculino" / "Feminino"
    quantity: int
    normal_active: bool
    event_only: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Assignment:
    position_code: str
    position_name: str
    category: str
    volunteer_id: int
    volunteer_name: str
    order: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class GenerationResult:
    assignments: list[Assignment]
    warnings: list[str] = field(default_factory=list)
