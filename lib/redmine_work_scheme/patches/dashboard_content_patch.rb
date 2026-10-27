# frozen_string_literal: true

# Legacy-интеграция с additionals 4.6 (класс-система DashboardBlocks
# появилась в 4.7; более старые legacy-версии не проверялись). Модуль
# объявляется безусловно и потому безопасен под eager-загрузку production
# без additionals; включается в DashboardContent только из init.rb, когда
# определён legacy-additionals.
module RedmineWorkScheme
  module Patches
    module DashboardContentPatch
      extend ActiveSupport::Concern

      included do
        prepend InstanceOverwriteMethods
      end

      module InstanceOverwriteMethods
        def block_definitions
          blocks = super
          # max_occurs не задаём: дефолт 1, как у класс-блока 4.7+ — все
          # экземпляры рендерят одну и ту же схему и делят одни настройки,
          # дубликаты смысла не имеют (и плодят дубликаты DOM-id).
          blocks['work_scheme'] = {
            label: l(:ws_label_scheme),
            partial: 'work_scheme/block'
          }
          blocks
        end
      end
    end
  end
end
